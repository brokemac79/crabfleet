import { render } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import {
  buildOpenClawIssuePrompt,
  openClawCandidatePriorityLabel,
  openClawCandidatePriorityRank,
} from "../openclaw-workflow.ts";
import {
  canMaintain,
  canOwn,
  elapsed,
  hasRunCapability,
  issueNumber,
  isActiveRun,
  isProvisioningInteractiveSession,
  lanes,
  linkedInteractiveSessionPlaceholder,
  optimisticInteractiveSession,
  preferredRepo,
  preferredRepos,
  runCapabilities,
  runtimeCapabilityLabel,
  sessionItems,
  statusLabel,
  terminalText,
  titleFromPrompt,
} from "./utils.js";
import {
  configureTerminalHub,
  disposeAllTerminals,
  disposeTerminal,
  disposeMissingTerminals,
  mountTerminal,
  warmGhosttyModule,
} from "./terminal.js";

const logo = "__CRABBOX_LOGO__";
const productName = "Crabfleet";
const productDomain = "clawfleet.openclaw.ai";
const sshHost = "crabd.sh";
const loginReturnKey = "crabbox-login-return";
const skipAutoGithubLoginKey = "crabbox-skip-auto-github-login";
const githubAutoLoginReadyKey = "crabbox-github-auto-login-ready";
const sessionLayoutStorageKey = "crabbox-session-layout-v1";
const clawQueuePath = "/app/claw-queue";
const openClawRunnerUrlStorageKey = "crabbox-openclaw-runner-url";
const openClawRunnerTokenStorageKey = "crabbox-openclaw-runner-token";
const defaultOpenClawRunnerUrl = "http://127.0.0.1:4545";
const emptyState = {
  cards: [],
  interactiveSessions: [],
  fleet: null,
  allow: [],
  repos: [],
  workflows: [],
  cap: 20,
  retention: "30",
  merge: "guarded",
};
const deadInteractiveStatuses = new Set(["stopped", "expired", "failed", "unavailable"]);

function initialState(initialSessionLink) {
  if (!initialSessionLink.id) return emptyState;
  return {
    ...emptyState,
    interactiveSessions: [
      linkedInteractiveSessionPlaceholder(initialSessionLink.id, {
        sharedReadOnly: Boolean(initialSessionLink.token),
      }),
    ],
  };
}

function App() {
  const githubLoginCallback = useRef(isGithubLoginCallback());
  const initialSessionLink = useMemo(() => {
    restoreSessionReturnUrl();
    return parseSessionLink();
  }, []);
  const [state, setState] = useState(() => initialState(initialSessionLink));
  const [signedIn, setSignedIn] = useState(false);
  const [authMethods, setAuthMethods] = useState({
    github: false,
    token: false,
    devIdentity: false,
  });
  const [loginMessage, setLoginMessage] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [appView, setAppViewState] = useState(initialAppView);
  const [drawers, setDrawers] = useState(initialSessionLink.route ? { sessions: true } : {});
  const [activeRunId, setActiveRunId] = useState(null);
  const [focusedSessionId, setFocusedSessionId] = useState(initialSessionLink.id);
  const [sharedSessionId, setSharedSessionId] = useState(initialSessionLink.id);
  const [sharedToken, setSharedToken] = useState(initialSessionLink.token);
  const [initialSessionOpened, setInitialSessionOpened] = useState(false);
  const [refPreview, setRefPreview] = useState({
    number: "",
    loading: false,
    matches: [],
    error: "",
  });
  const [theme, setThemeState] = useState(
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  const [sessionLayout, setSessionLayout] = useState(loadSessionLayout);
  const [terminalStatus, setTerminalStatus] = useState({});
  const [openClawState, setOpenClawState] = useState({
    loading: false,
    data: null,
    error: "",
    handoffText: "",
  });
  const [openClawRunner, setOpenClawRunner] = useState(loadOpenClawRunnerSettings);
  const stateRef = useRef(state);
  const authMethodsRef = useRef(authMethods);
  const signedInRef = useRef(signedIn);
  const activeRunIdRef = useRef(activeRunId);
  const focusedSessionIdRef = useRef(focusedSessionId);
  const drawersRef = useRef(drawers);
  const sharedRef = useRef({ id: sharedSessionId, token: sharedToken });
  const stateRetryTimer = useRef(null);
  const refPreviewTimer = useRef(null);
  const refPreviewSeq = useRef(0);
  const openClawSeq = useRef(0);
  const openClawRunnerAutoChecked = useRef(false);
  const draggedSessionId = useRef(null);
  const autoLoginStarted = useRef(false);

  const allSessionItems = useMemo(() => sessionItems(state), [state]);
  const sessionItemById = useMemo(
    () => new Map(allSessionItems.map((item) => [item.id, item])),
    [allSessionItems],
  );

  stateRef.current = state;
  authMethodsRef.current = authMethods;
  signedInRef.current = signedIn;
  activeRunIdRef.current = activeRunId;
  focusedSessionIdRef.current = focusedSessionId;
  drawersRef.current = drawers;
  sharedRef.current = { id: sharedSessionId, token: sharedToken };

  useEffect(() => {
    void loadState();
    const interval = setInterval(() => {
      if (signedInRef.current) {
        void loadState();
        return;
      }
      const shared = sharedRef.current;
      if (shared.id && shared.token && !document.body.classList.contains("locked")) {
        loadSharedSession().catch((error) => {
          if (error.status === 403 || error.status === 404) {
            void showSharedLinkError(error);
            return;
          }
          console.warn("Shared session refresh failed", error);
        });
      }
    }, 15000);
    return () => {
      clearInterval(interval);
      if (stateRetryTimer.current) clearTimeout(stateRetryTimer.current);
      if (refPreviewTimer.current) clearTimeout(refPreviewTimer.current);
      disposeAllTerminals();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.appRuntime = "preact";
    document.body.classList.toggle("locked", !signedIn && !(sharedSessionId && sharedToken));
  }, [signedIn, sharedSessionId, sharedToken]);

  useEffect(() => {
    const onPopState = () => setAppViewState(initialAppView());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!signedIn && !loginMessage) void maybeAutoGithubLogin(authMethods);
  }, [signedIn, loginMessage, authMethods.github, sharedSessionId, sharedToken]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("crabbox-theme", theme);
    } catch {}
  }, [theme]);

  useEffect(() => {
    configureTerminalHub({
      sharedSessionId,
      sharedToken,
      sessions: () => sessionItems(stateRef.current),
      onStatus: (id, label) =>
        setTerminalStatus((current) => {
          if (current[id] === label) return current;
          return { ...current, [id]: label };
        }),
    });
  }, [sharedSessionId, sharedToken, state]);

  useEffect(() => {
    if (!sharedSessionId) return;
    void openInitialSessionLink();
  }, [sharedSessionId, signedIn, state.interactiveSessions]);

  useEffect(() => {
    if (!signedIn || appView !== "openclaw") return;
    void loadOpenClawWorkflow();
  }, [signedIn, appView]);

  useEffect(() => {
    if (!signedIn || appView !== "openclaw" || openClawRunner.status !== "unknown") return;
    if (!openClawRunner.saved) return;
    if (openClawRunnerAutoChecked.current) return;
    openClawRunnerAutoChecked.current = true;
    void checkOpenClawRunner(openClawRunner).catch(() => {});
  }, [
    signedIn,
    appView,
    openClawRunner.status,
    openClawRunner.url,
    openClawRunner.token,
    openClawRunner.saved,
  ]);

  useEffect(() => {
    if (!signedIn || appView !== "openclaw" || openClawRunner.status !== "connected") return;
    void refreshOpenClawRunnerRuns().catch(() => {});
    const interval = setInterval(() => {
      void refreshOpenClawRunnerRuns().catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, [signedIn, appView, openClawRunner.status, openClawRunner.url, openClawRunner.token]);

  async function loadState() {
    try {
      const nextState = await api("/api/state", { authOptional: true });
      const linkedSessionId = sharedRef.current.id;
      const linkedSession = linkedSessionId ? findInteractiveSession(linkedSessionId) : null;
      if (
        linkedSession &&
        !(nextState.interactiveSessions || []).some((session) => session.id === linkedSessionId)
      ) {
        nextState.interactiveSessions = [linkedSession, ...(nextState.interactiveSessions || [])];
      }
      const activeRunId = activeRunIdRef.current;
      const activeCard = nextState.cards.find((card) => card.id === activeRunId);
      if (activeRunId && drawersRef.current.run && activeCard?.changes?.files?.length) {
        const result = await api(`/api/cards/${encodeURIComponent(activeRunId)}/actions`, {
          method: "POST",
          body: { action: "attach" },
        });
        nextState.cards = nextState.cards.map((card) =>
          card.id === result.card.id ? result.card : card,
        );
      }
      if (stateRetryTimer.current) clearTimeout(stateRetryTimer.current);
      stateRetryTimer.current = null;
      setAuthMethods(nextState.auth || authMethodsRef.current);
      setState(nextState);
      setSignedIn(true);
      setLoginMessage("");
      finishGithubLoginCallback(true);
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        const shared = sharedRef.current;
        if (shared.id && shared.token) {
          try {
            await loadSharedSession();
          } catch (sharedError) {
            await showSharedLinkError(sharedError);
          }
          return;
        }
        const methods = await loadAuthMethods();
        finishGithubLoginCallback(false);
        if (error.status === 401 && (await maybeAutoGithubLogin(methods))) return;
        setSignedIn(false);
        setLoginMessage(error.message === "unauthorized" ? "" : error.message);
        return;
      }
      setLoginMessage(error.message);
      stateRetryTimer.current ||= setTimeout(() => {
        stateRetryTimer.current = null;
        void loadState();
      }, 5000);
    }
  }

  async function loadSharedSession() {
    const result = await api(
      `/api/shared-sessions/${encodeURIComponent(sharedSessionId)}?token=${encodeURIComponent(sharedToken)}`,
      { authOptional: true },
    );
    await loadAuthMethods();
    setState({
      user: { subject: "shared", login: "shared link", role: "viewer" },
      auth: authMethods,
      org: "OpenClaw",
      cap: 20,
      retention: "30",
      merge: "guarded",
      allow: [],
      repos: [result.session.repo],
      workflows: [],
      cards: [],
      interactiveSessions: [result.session],
    });
    setSignedIn(false);
    setFocusedSessionId(result.session.id);
    openSessionGrid(result.session.id, { deepLink: true });
  }

  async function loadLinkedInteractiveSession(id) {
    const result = await api(`/api/interactive-sessions/${encodeURIComponent(id)}`);
    upsertInteractiveSession(result.session);
    setInitialSessionOpened(true);
    setFocusedSessionId(result.session.id);
    openSessionGrid(result.session.id, { deepLink: true });
  }

  async function showSharedLinkError(error) {
    await loadAuthMethods();
    setSharedSessionId(null);
    setSharedToken(null);
    setFocusedSessionId(null);
    setInitialSessionOpened(true);
    setSessionUrl(null);
    setSignedIn(false);
    setLoginMessage(
      error?.status === 404
        ? "Shared session link is invalid or expired."
        : error?.message || "Shared session could not be loaded.",
    );
  }

  async function loadAuthMethods() {
    try {
      const result = await api("/api/auth", { authOptional: true });
      const methods = result.auth || authMethodsRef.current;
      setAuthMethods(methods);
      return methods;
    } catch {
      const methods = { github: false, token: true, devIdentity: false };
      setAuthMethods(methods);
      return methods;
    }
  }

  async function openInitialSessionLink() {
    if (!sharedSessionId) return;
    const existing = findInteractiveSession(sharedSessionId);
    if (!existing || existing.routePlaceholder) {
      if (
        signedIn &&
        (!initialSessionOpened || focusedSessionId === sharedSessionId) &&
        existing?.status !== "unavailable"
      ) {
        try {
          await loadLinkedInteractiveSession(sharedSessionId);
        } catch (error) {
          if (error.status !== 403 && error.status !== 404) throw error;
          upsertInteractiveSession(
            linkedInteractiveSessionPlaceholder(sharedSessionId, {
              status: "unavailable",
              lastEvent:
                error.status === 404
                  ? "Codex session was not found."
                  : "You do not have access to this Codex session.",
              sharedReadOnly: Boolean(sharedToken),
            }),
          );
          setInitialSessionOpened(true);
          setFocusedSessionId(sharedSessionId);
          openSessionGrid(sharedSessionId);
        }
      } else if (
        !signedIn &&
        sharedToken &&
        existing?.status !== "unavailable" &&
        !document.body.classList.contains("locked")
      ) {
        await loadSharedSession();
      } else if (!initialSessionOpened) {
        if (!existing) {
          upsertInteractiveSession(
            linkedInteractiveSessionPlaceholder(sharedSessionId, {
              sharedReadOnly: Boolean(sharedToken),
            }),
          );
        }
        setInitialSessionOpened(true);
        setFocusedSessionId(sharedSessionId);
        openSessionGrid(sharedSessionId);
      }
      return;
    }
    if (initialSessionOpened && focusedSessionId !== sharedSessionId) return;
    setInitialSessionOpened(true);
    setFocusedSessionId(sharedSessionId);
    openSessionGrid(sharedSessionId);
  }

  function findCard(id) {
    return stateRef.current.cards.find((card) => card.id === id);
  }

  function findInteractiveSession(id) {
    return (stateRef.current.interactiveSessions || []).find((session) => session.id === id);
  }

  function upsertCard(card) {
    setState((current) => ({
      ...current,
      cards: current.cards.map((item) => (item.id === card.id ? card : item)),
    }));
  }

  function upsertInteractiveSession(session) {
    setState((current) => {
      const sessions = current.interactiveSessions || [];
      return {
        ...current,
        interactiveSessions: sessions.some((item) => item.id === session.id)
          ? sessions.map((item) => (item.id === session.id ? session : item))
          : [session, ...sessions],
      };
    });
  }

  function removeInteractiveSession(id) {
    setState((current) => ({
      ...current,
      interactiveSessions: (current.interactiveSessions || []).filter(
        (session) => session.id !== id,
      ),
    }));
  }

  function openDrawer(id) {
    setDrawers((current) => ({ ...current, [id]: true }));
  }

  function closeDrawer(id) {
    setDrawers((current) => ({ ...current, [id]: false }));
    if (id === "run") setActiveRunId(null);
    if (id === "sessions") {
      setFocusedSessionId(null);
      if (!sharedToken) setSessionUrl(null);
      disposeAllTerminals();
    }
  }

  function closeAllDrawers() {
    setDrawers({});
    setActiveRunId(null);
    setFocusedSessionId(null);
    if (!sharedToken) setSessionUrl(null);
    disposeAllTerminals();
  }

  function setAppView(value) {
    const next = value === "board" ? "board" : value === "openclaw" ? "openclaw" : "fleet";
    setAppViewState(next);
    closeAllDrawers();
    if (!history.pushState) return;
    const url = new URL(location.href);
    url.pathname =
      next === "board" ? "/app/board" : next === "openclaw" ? clawQueuePath : "/app/fleet";
    url.search = "";
    history.pushState(null, "", url);
  }

  function closeTopDrawer() {
    const order = ["card", "interactive", "run", "sessions", "admin"];
    const id = order.findLast((key) => drawers[key]);
    if (!id) return false;
    closeDrawer(id);
    return true;
  }

  function showSessionGrid() {
    setFocusedSessionId(null);
    if (!sharedToken) setSessionUrl(null, { grid: true });
    setDrawers((current) => ({ ...current, sessions: true }));
  }

  function openSessionGrid(id, options = {}) {
    const targetId = id === undefined ? focusedSessionIdRef.current : id;
    if (targetId) setFocusedSessionId(targetId);
    else if (id === null) setFocusedSessionId(null);
    const deepLink =
      options.deepLink ??
      Boolean(targetId && sessionItemById.get(targetId)?.kind === "interactive");
    const urlSessionId =
      targetId && deepLink && !String(targetId).startsWith("LOCAL-") ? targetId : null;
    if (urlSessionId) setSessionUrl(urlSessionId);
    else if (!sharedToken) setSessionUrl(null, { grid: true });
    warmGhosttyModule();
    setDrawers((current) => ({ ...current, sessions: true }));
  }

  function setSessionUrl(id, options = {}) {
    if (!history.replaceState) return;
    if (id) {
      const url = new URL(location.href);
      url.pathname = `/sessions/${encodeURIComponent(id)}`;
      url.search = "";
      if (sharedToken && id === sharedSessionId) url.searchParams.set("token", sharedToken);
      history.replaceState(null, "", url);
      return;
    }
    const url = new URL(location.href);
    url.pathname = options.grid
      ? "/sessions"
      : appView === "board"
        ? "/app/board"
        : appView === "openclaw"
          ? clawQueuePath
          : "/app/fleet";
    url.search = "";
    history.replaceState(null, "", url);
  }

  async function loadOpenClawWorkflow(params = {}) {
    const seq = ++openClawSeq.current;
    const query = new URLSearchParams();
    if (params.repo) query.set("repo", params.repo);
    if (params.login) query.set("login", params.login);
    const queryText = query.toString();
    setOpenClawState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const data = await api(`/api/openclaw/workflow${queryText ? `?${queryText}` : ""}`);
      if (seq !== openClawSeq.current) return;
      setOpenClawState((current) => ({ ...current, loading: false, data, error: "" }));
    } catch (error) {
      if (seq !== openClawSeq.current) return;
      setOpenClawState((current) => ({
        ...current,
        loading: false,
        error: error.message || "Claw Queue failed to load",
      }));
    }
  }

  async function updateOpenClawPreferences(preferences) {
    const result = await api("/api/openclaw/preferences", {
      method: "PUT",
      body: preferences,
    });
    setOpenClawState((current) => ({
      ...current,
      data: current.data ? { ...current.data, preferences: result.preferences } : current.data,
    }));
    await loadOpenClawWorkflow({
      repo: result.preferences?.targetRepo,
      login: result.preferences?.githubLogin,
    });
  }

  async function createOpenClawCandidateCard(candidate) {
    const prompt = openClawCandidatePrompt(candidate);
    await api("/api/cards", {
      method: "POST",
      body: {
        title: `OpenClaw #${candidate.number}: ${candidate.title}`,
        prompt,
        repo: openClawState.data?.repo || "openclaw/openclaw",
        source: "Issue",
        runtime: "auto",
        policy: "open_pr",
      },
    });
    await loadState();
  }

  async function copyOpenClawCandidatePrompt(candidate) {
    await copyText(openClawCandidatePrompt(candidate));
  }

  function updateOpenClawRunnerSettings(next) {
    const settings = {
      ...openClawRunner,
      ...next,
      url: next.url === undefined ? openClawRunner.url : String(next.url),
      token: String(next.token ?? openClawRunner.token ?? ""),
    };
    try {
      localStorage.setItem(openClawRunnerUrlStorageKey, settings.url);
      localStorage.setItem(openClawRunnerTokenStorageKey, settings.token);
    } catch {}
    setOpenClawRunner(settings);
    return settings;
  }

  async function checkOpenClawRunner(settings = openClawRunner) {
    const target = updateOpenClawRunnerSettings(settings);
    setOpenClawRunner((current) => ({ ...current, status: "checking", error: "" }));
    try {
      const response = await fetch(`${resolveRunnerUrl(target.url)}/health`, {
        headers: openClawRunnerHeaders(target),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true || body.runner !== "claw-queue-codex-bridge") {
        throw new Error(body.error || `Runner returned ${response.status}`);
      }
      const runs = await fetchOpenClawRunnerRuns(target);
      setOpenClawRunner((current) => ({
        ...current,
        status: "connected",
        error: "",
        info: body,
        runs,
        runsError: "",
      }));
      return body;
    } catch (error) {
      setOpenClawRunner((current) => ({
        ...current,
        status: "error",
        error: error.message || "Could not reach local Codex runner",
      }));
      throw error;
    }
  }

  async function startOpenClawCodexWork(candidate) {
    if (!openClawState.data?.governor?.canStartNewWork) {
      throw new Error("New work is paused by the current OpenClaw limits");
    }
    const target = openClawRunner;
    setOpenClawRunner((current) => ({
      ...current,
      startingIssue: candidate.number,
      error: "",
    }));
    try {
      const response = await fetch(`${resolveRunnerUrl(target.url)}/start`, {
        method: "POST",
        headers: {
          ...openClawRunnerHeaders(target),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          repo: openClawState.data?.repo || "openclaw/openclaw",
          issueNumber: candidate.number,
          issueUrl: candidate.url,
          title: candidate.title,
          queueId: candidate.queueId,
          prompt: openClawCandidatePrompt(candidate),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) {
        throw new Error(body.error || `Runner returned ${response.status}`);
      }
      const runs = await fetchOpenClawRunnerRuns(target).catch(() =>
        body.run ? [body.run, ...(openClawRunner.runs || [])] : openClawRunner.runs || [],
      );
      setOpenClawRunner((current) => ({
        ...current,
        status: "connected",
        startingIssue: null,
        lastRun: body.run || body,
        runs,
        runsError: "",
      }));
      return body;
    } catch (error) {
      setOpenClawRunner((current) => ({
        ...current,
        status: "error",
        startingIssue: null,
        error: error.message || "Could not start local Codex",
      }));
      throw error;
    }
  }

  async function trackOpenClawCandidateWork(candidate) {
    const target = openClawRunner;
    setOpenClawRunner((current) => ({
      ...current,
      trackingIssue: candidate.number,
      error: "",
    }));
    try {
      const response = await fetch(`${resolveRunnerUrl(target.url)}/track`, {
        method: "POST",
        headers: {
          ...openClawRunnerHeaders(target),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          repo: openClawState.data?.repo || "openclaw/openclaw",
          issueNumber: candidate.number,
          issueUrl: candidate.url,
          title: candidate.title,
          queueId: candidate.queueId,
          source: "manual",
          prompt: openClawCandidatePrompt(candidate),
          note: "Tracked for copy/paste, tmux, or external Codex work.",
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) {
        throw new Error(body.error || `Runner returned ${response.status}`);
      }
      const runs = await fetchOpenClawRunnerRuns(target).catch(() =>
        body.run ? [body.run, ...(openClawRunner.runs || [])] : openClawRunner.runs || [],
      );
      setOpenClawRunner((current) => ({
        ...current,
        status: "connected",
        trackingIssue: null,
        lastRun: body.run || body,
        runs,
        runsError: "",
      }));
      return body;
    } catch (error) {
      setOpenClawRunner((current) => ({
        ...current,
        trackingIssue: null,
        error: error.message || "Could not track local Codex work",
      }));
      throw error;
    }
  }

  async function updateOpenClawRunnerRun(run, patch) {
    const target = openClawRunner;
    const response = await fetch(
      `${resolveRunnerUrl(target.url)}/runs/${encodeURIComponent(run.id)}`,
      {
        method: "PATCH",
        headers: {
          ...openClawRunnerHeaders(target),
          "content-type": "application/json",
        },
        body: JSON.stringify(patch),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      throw new Error(body.error || `Runner returned ${response.status}`);
    }
    const runs = await fetchOpenClawRunnerRuns(target).catch(() =>
      (openClawRunner.runs || []).map((item) => (item.id === body.run?.id ? body.run : item)),
    );
    setOpenClawRunner((current) => ({ ...current, runs, runsError: "" }));
    return body.run;
  }

  async function refreshOpenClawRunnerRuns(settings = openClawRunner) {
    const target = settings;
    setOpenClawRunner((current) => ({ ...current, runsLoading: true, runsError: "" }));
    try {
      const runs = await fetchOpenClawRunnerRuns(target);
      setOpenClawRunner((current) => ({
        ...current,
        status: current.status === "error" ? "connected" : current.status,
        runs,
        runsLoading: false,
        runsError: "",
      }));
      return runs;
    } catch (error) {
      setOpenClawRunner((current) => ({
        ...current,
        runsLoading: false,
        runsError: error.message || "Could not load local Codex runs",
      }));
      throw error;
    }
  }

  async function createOpenClawHandoff(input) {
    const result = await api("/api/openclaw/handoff", {
      method: "POST",
      body: input,
    });
    setOpenClawState((current) => ({ ...current, handoffText: result.text || "" }));
    return result.text || "";
  }

  function setTheme(value) {
    setThemeState(value === "light" ? "light" : "dark");
  }

  async function beginLogin() {
    try {
      sessionStorage.removeItem(skipAutoGithubLoginKey);
    } catch {}
    preserveLoginReturnUrl();
    let methods = authMethods;
    if (!methods.github && !methods.token) methods = await loadAuthMethods();
    if (methods.github) {
      location.href = "/login/github";
      return;
    }
    setLoginMessage("Sign in to request terminal control.");
  }

  async function tokenLogin(token) {
    try {
      await api("/api/login/token", { method: "POST", body: { token }, authOptional: true });
      await loadState();
    } catch (error) {
      setLoginMessage(String(error.message || error));
    }
  }

  async function devIdentityLogin(identity) {
    try {
      await api("/api/login/dev", {
        method: "POST",
        body: identity,
        authOptional: true,
      });
      await loadState();
    } catch (error) {
      setLoginMessage(String(error.message || error));
    }
  }

  async function logout() {
    try {
      sessionStorage.setItem(skipAutoGithubLoginKey, "1");
      localStorage.removeItem(githubAutoLoginReadyKey);
    } catch {}
    autoLoginStarted.current = false;
    await api("/api/logout", { method: "POST", authOptional: true });
    await loadState();
  }

  async function maybeAutoGithubLogin(methods = authMethodsRef.current) {
    if (signedInRef.current || autoLoginStarted.current || !methods?.github) return false;
    if (methods.devIdentity) return false;
    if (methods.token && wantsTokenLoginBypass()) return false;
    const shared = sharedRef.current;
    if (shared.id && shared.token) return false;
    try {
      if (sessionStorage.getItem(skipAutoGithubLoginKey) === "1") return false;
      if (localStorage.getItem(githubAutoLoginReadyKey) !== "1") return false;
    } catch {
      return false;
    }
    autoLoginStarted.current = true;
    preserveLoginReturnUrl();
    location.href = "/login/github";
    return true;
  }

  function preserveLoginReturnUrl() {
    try {
      if (sharedRef.current.id) sessionStorage.setItem(loginReturnKey, location.href);
    } catch {}
  }

  function wantsTokenLoginBypass() {
    const params = new URLSearchParams(location.search);
    return params.get("auth") === "token";
  }

  function finishGithubLoginCallback(remember) {
    if (!githubLoginCallback.current) return;
    githubLoginCallback.current = false;
    if (remember) {
      try {
        localStorage.setItem(githubAutoLoginReadyKey, "1");
      } catch {}
    }
    if (!history.replaceState) return;
    const url = new URL(location.href);
    if (url.searchParams.get("login") !== "github") return;
    url.searchParams.delete("login");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  async function cardAction(id, action) {
    const result = await api(`/api/cards/${encodeURIComponent(id)}/actions`, {
      method: "POST",
      body: { action },
    });
    upsertCard(result.card);
  }

  async function attachCard(id) {
    const result = await api(`/api/cards/${encodeURIComponent(id)}/actions`, {
      method: "POST",
      body: { action: "attach" },
    });
    upsertCard(result.card);
    openSessionGrid(id);
  }

  async function interactiveSessionAction(id, action) {
    const result = await api(`/api/interactive-sessions/${encodeURIComponent(id)}/actions`, {
      method: "POST",
      body: { action },
    });
    upsertInteractiveSession(result.session);
    if (action === "stop") return result;
    openSessionGrid(id, { deepLink: true });
    return result;
  }

  async function closeInteractiveSession(id) {
    const session = findInteractiveSession(id);
    const label = session ? `${session.repo} (${session.id})` : id;
    if (!window.confirm(`End Codex session ${label}?`)) return null;
    return interactiveSessionAction(id, "stop");
  }

  async function cleanupInteractiveSessions(ids) {
    const result = await api("/api/interactive-sessions/cleanup", {
      method: "POST",
      body: { ids },
    });
    setState(result.state);
    const removed = new Set(result.removedIds || []);
    if (removed.has(focusedSessionIdRef.current)) {
      setFocusedSessionId(null);
      if (!sharedToken) setSessionUrl(null, { grid: true });
    }
    for (const id of removed) disposeTerminal(id);
    return result;
  }

  async function cleanupInteractiveSession(id) {
    const session = findInteractiveSession(id);
    const label = session ? `${session.repo} (${session.id})` : id;
    if (!window.confirm(`Clean up dead Codex session ${label}?`)) return null;
    if (session?.routePlaceholder) {
      removeInteractiveSession(id);
      if (focusedSessionIdRef.current === id) setFocusedSessionId(null);
      if (!sharedToken) setSessionUrl(null, { grid: true });
      return { removedIds: [id] };
    }
    return cleanupInteractiveSessions([id]);
  }

  async function cleanupDeadInteractiveSessions() {
    const user = stateRef.current.user;
    const ids = (stateRef.current.interactiveSessions || [])
      .filter((session) => canCleanInteractiveSession(session, user))
      .map((session) => session.id);
    if (!ids.length) return null;
    if (!window.confirm(`Clean up ${ids.length} dead Codex session${ids.length === 1 ? "" : "s"}?`))
      return null;
    return cleanupInteractiveSessions(ids);
  }

  async function shareInteractiveSession(id) {
    const result = await interactiveSessionAction(id, "share_link");
    if (!result.shareUrl) return;
    let copied = false;
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(result.shareUrl);
        copied = true;
      }
    } catch {}
    if (!copied) window.prompt("Copy share link", result.shareUrl);
  }

  async function openRunDetails(id) {
    closeDrawer("sessions");
    setActiveRunId(id);
    let card = findCard(id);
    if (!card) return;
    try {
      const result = await api(`/api/cards/${encodeURIComponent(id)}/actions`, {
        method: "POST",
        body: { action: "attach" },
      });
      upsertCard(result.card);
      card = result.card;
    } catch (error) {
      setLoginMessage(error.message);
      return;
    }
    openDrawer("run");
  }

  function scheduleRefPreview(value) {
    const number = issueNumber(value);
    refPreviewSeq.current += 1;
    if (refPreviewTimer.current) clearTimeout(refPreviewTimer.current);
    if (!number) {
      setRefPreview({ number: "", loading: false, matches: [], error: "" });
      return;
    }
    setRefPreview({ number, loading: true, matches: [], error: "" });
    const seq = refPreviewSeq.current;
    refPreviewTimer.current = setTimeout(() => loadRefPreview(number, seq), 220);
  }

  async function loadRefPreview(number, seq) {
    try {
      const result = await api(`/api/github/refs?number=${encodeURIComponent(number)}`);
      if (seq !== refPreviewSeq.current) return;
      setRefPreview({ number, loading: false, matches: result.matches || [], error: "" });
    } catch (error) {
      if (seq !== refPreviewSeq.current) return;
      setRefPreview({
        number,
        loading: false,
        matches: [],
        error: error.message || "GitHub lookup failed",
      });
    }
  }

  async function createRefCard(index) {
    const match = refPreview.matches[index];
    if (!match) return;
    await api("/api/cards", {
      method: "POST",
      body: {
        title: `${match.repo}#${match.number}: ${match.title}`,
        prompt: `${match.source} ${match.url}\n\n${match.title}\n\n${match.body || ""}`,
        repo: match.repo,
        source: match.source,
        runtime: "auto",
        policy: "",
      },
    });
    setRefPreview({ number: "", loading: false, matches: [], error: "" });
    setSearch("");
    await loadState();
  }

  async function createCard(form) {
    const data = new FormData(form);
    await api("/api/cards", {
      method: "POST",
      body: {
        title: data.get("title") || titleFromPrompt(data.get("prompt")),
        prompt: data.get("prompt"),
        repo: data.get("repo"),
        source: data.get("source"),
        runtime: data.get("runtime"),
        policy: data.get("policy"),
      },
    });
    form.reset();
    closeDrawer("card");
    await loadState();
  }

  async function createInteractiveSession(form) {
    const data = new FormData(form);
    const optimistic = optimisticInteractiveSession(data, state.user?.login);
    upsertInteractiveSession(optimistic);
    closeDrawer("interactive");
    setFocusedSessionId(optimistic.id);
    openSessionGrid(optimistic.id);
    try {
      const result = await api("/api/interactive-sessions", {
        method: "POST",
        body: {
          repo: data.get("repo"),
          branch: data.get("branch"),
          runtime: data.get("runtime"),
          command: data.get("command"),
          prompt: data.get("prompt"),
        },
      });
      removeInteractiveSession(optimistic.id);
      upsertInteractiveSession(result.session);
      form.reset();
      form.elements.branch.value = "main";
      form.elements.command.value = "codex --yolo";
      setFocusedSessionId(result.session.id);
      openSessionGrid(result.session.id, { deepLink: true });
    } catch (error) {
      upsertInteractiveSession({
        ...optimistic,
        status: "failed",
        lastEvent: error.message || "session creation failed",
        logs: [error.message || "session creation failed"],
      });
      setLoginMessage(error.message || "session creation failed");
    }
  }

  async function addAllow(value, role) {
    setState(await api("/api/admin/allow", { method: "POST", body: { value, role } }));
  }

  async function removeAllow(value) {
    setState(await api(`/api/admin/allow/${encodeURIComponent(value)}`, { method: "DELETE" }));
  }

  async function addRepo(repo) {
    setState(await api("/api/admin/repos", { method: "POST", body: { repo } }));
  }

  async function removeRepo(repo) {
    setState(await api(`/api/admin/repos/${encodeURIComponent(repo)}`, { method: "DELETE" }));
  }

  async function refreshWorkflow(repo) {
    setState(await api("/api/admin/workflows/evaluate", { method: "POST", body: { repo } }));
  }

  async function updatePolicy(policy) {
    setState(await api("/api/admin/policy", { method: "PUT", body: policy }));
  }

  function updateSessionLayout(updater) {
    setSessionLayout((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      saveSessionLayout(next);
      return next;
    });
  }

  const props = {
    state,
    appView,
    setAppView,
    signedIn,
    authMethods,
    loginMessage,
    filter,
    setFilter,
    search,
    setSearch: (value) => {
      setSearch(value);
      scheduleRefPreview(value);
    },
    drawers,
    activeRunId,
    focusedSessionId,
    sharedSessionId,
    sharedToken,
    setFocusedSessionId,
    showSessionGrid,
    refPreview,
    theme,
    terminalStatus,
    sessionLayout,
    setSessionLayout: updateSessionLayout,
    draggedSessionId,
    allSessionItems,
    sessionItemById,
    openDrawer,
    closeDrawer,
    closeAllDrawers,
    closeTopDrawer,
    openSessionGrid,
    beginLogin,
    tokenLogin,
    devIdentityLogin,
    logout,
    setTheme,
    cardAction,
    attachCard,
    interactiveSessionAction,
    closeInteractiveSession,
    cleanupInteractiveSession,
    cleanupDeadInteractiveSessions,
    shareInteractiveSession,
    openRunDetails,
    createRefCard,
    createCard,
    createInteractiveSession,
    addAllow,
    removeAllow,
    addRepo,
    removeRepo,
    refreshWorkflow,
    updatePolicy,
    openClawState,
    openClawRunner,
    loadOpenClawWorkflow,
    updateOpenClawPreferences,
    createOpenClawCandidateCard,
    copyOpenClawCandidatePrompt,
    updateOpenClawRunnerSettings,
    checkOpenClawRunner,
    refreshOpenClawRunnerRuns,
    trackOpenClawCandidateWork,
    updateOpenClawRunnerRun,
    startOpenClawCodexWork,
    createOpenClawHandoff,
  };

  return <CrabfleetApp {...props} />;
}

function CrabfleetApp(props) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "Escape" || event.isComposing || isTerminalKeyTarget(event)) return;
      if (props.closeTopDrawer()) event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [props.drawers]);

  return (
    <>
      <LoginScreen
        hidden={
          props.signedIn ||
          Boolean(props.sharedSessionId && props.sharedToken && !props.loginMessage) ||
          (props.state.user?.subject === "shared" && !props.loginMessage)
        }
        authMethods={props.authMethods}
        message={props.loginMessage}
        onGithub={props.beginLogin}
        onToken={props.tokenLogin}
        onDevIdentity={props.devIdentityLogin}
      />
      <AppShell {...props} />
      <CardDrawer {...props} />
      <InteractiveDrawer {...props} />
      <RunDrawer {...props} />
      <SessionsDrawer {...props} />
      <AdminDrawer {...props} />
    </>
  );
}

const devIdentityPresets = [
  { id: "admin-1", name: "Admin 1", role: "owner" },
  { id: "admin-2", name: "Admin 2", role: "owner" },
  { id: "user-1", name: "User 1", role: "maintainer" },
  { id: "user-2", name: "User 2", role: "viewer" },
];

function LoginScreen({ hidden, authMethods, message, onGithub, onToken, onDevIdentity }) {
  const [token, setToken] = useState("");
  return (
    <section class="login-screen" hidden={hidden}>
      <a class="login-back" href="/docs/">
        &larr; documentation
      </a>
      <InfrastructureField />
      <form
        class="login-panel"
        onSubmit={(event) => {
          event.preventDefault();
          void onToken(token);
          setToken("");
        }}
      >
        <div class="login-brand">
          <div class="mark">
            <img src={logo} alt="" />
          </div>
          <h1>{productName}</h1>
        </div>
        <p>OpenClaw crabboxes, SSH-first.</p>
        <div class="login-actions">
          <button
            class="primary github-login"
            type="button"
            hidden={!authMethods.github}
            disabled={!authMethods.github}
            onClick={onGithub}
          >
            <Icon name="git-pull-request" />
            Sign in with GitHub
          </button>
          <div class="command-row">
            <span>Or connect via</span>
            <CopyCommand value={`ssh link@${sshHost}`} />
          </div>
          <details
            class="bootstrap-login"
            hidden={!authMethods.token}
            {...(authMethods.token && !authMethods.github && !authMethods.devIdentity
              ? { open: true }
              : {})}
          >
            <summary>Use bootstrap token</summary>
            <div class="bootstrap-login-fields">
              <label>
                Bootstrap token
                <input
                  type="password"
                  autocomplete="current-password"
                  disabled={!authMethods.token}
                  value={token}
                  onInput={(event) => setToken(event.currentTarget.value)}
                />
              </label>
              <button type="submit" disabled={!authMethods.token}>
                Use token
              </button>
            </div>
          </details>
        </div>
        <DevIdentityPanel
          hidden={!authMethods.devIdentity}
          user={null}
          onDevIdentity={onDevIdentity}
        />
        <div class={`banner ${message ? "show" : ""}`}>{message}</div>
        <div class="login-footer">
          <a href="/docs/">Documentation</a>
        </div>
      </form>
    </section>
  );
}

const infraBlocks = [
  { x: "50%", y: "31%", w: "86px", h: "48px", o: "0.95", d: "0s" },
  { x: "41%", y: "39%", w: "92px", h: "44px", o: "0.56", d: "-1.1s" },
  { x: "59%", y: "39%", w: "86px", h: "38px", o: "0.5", d: "-2.4s" },
  { x: "34%", y: "49%", w: "104px", h: "42px", o: "0.34", d: "-3.1s" },
  { x: "66%", y: "49%", w: "106px", h: "46px", o: "0.33", d: "-0.8s" },
  { x: "27%", y: "61%", w: "96px", h: "36px", o: "0.24", d: "-2.2s" },
  { x: "73%", y: "61%", w: "96px", h: "36px", o: "0.24", d: "-1.8s" },
  { x: "43%", y: "64%", w: "106px", h: "42px", o: "0.3", d: "-3.7s" },
  { x: "57%", y: "65%", w: "100px", h: "40px", o: "0.28", d: "-0.5s" },
  { x: "18%", y: "73%", w: "112px", h: "38px", o: "0.19", d: "-2.9s" },
  { x: "82%", y: "73%", w: "108px", h: "38px", o: "0.18", d: "-4.1s" },
  { x: "34%", y: "80%", w: "98px", h: "36px", o: "0.18", d: "-0.3s" },
  { x: "67%", y: "81%", w: "96px", h: "36px", o: "0.16", d: "-2.7s" },
  { x: "50%", y: "87%", w: "104px", h: "34px", o: "0.12", d: "-3.5s" },
];

function InfrastructureField() {
  return (
    <div class="infra-field" aria-hidden="true">
      {infraBlocks.map((block, index) => (
        <span
          class={index === 0 ? "infra-block focus" : "infra-block"}
          style={{
            "--x": block.x,
            "--y": block.y,
            "--w": block.w,
            "--h": block.h,
            "--o": block.o,
            "--d": block.d,
          }}
        />
      ))}
    </div>
  );
}

function AppShell(props) {
  const active = props.state.cards.filter((card) => card.lane === "Running").length;
  const queue = props.state.cards.filter((card) => card.lane === "Todo").length;
  const review = props.state.cards.filter((card) => card.lane === "Human Review").length;
  const cli = (props.state.interactiveSessions || []).filter((session) =>
    ["provisioning", "pending_adapter", "ready", "attached", "detached"].includes(session.status),
  ).length;
  const user = props.state.user;
  const userLabel =
    !props.signedIn && user?.subject === "shared"
      ? "Sign in for control"
      : user
        ? `${user.login || user.email || user.subject} / ${user.role}`
        : "Signed out";
  return (
    <div class="app">
      <aside class="rail" aria-label="Primary">
        <div class="brand-lockup" title={productDomain}>
          <div class="mark">
            <img src={logo} alt="" />
          </div>
          <span>crabfleet</span>
        </div>
        <div class="nav-actions">
          <button
            class={props.appView === "fleet" ? "active" : ""}
            title="Fleet"
            aria-label="Fleet"
            onClick={() => props.setAppView("fleet")}
          >
            <Icon name="layout-grid" />
            <span>Fleet</span>
          </button>
          <button
            class={props.appView === "board" ? "active" : ""}
            title="Board"
            aria-label="Board"
            onClick={() => props.setAppView("board")}
          >
            <Icon name="square-terminal" />
            <span>Board</span>
          </button>
          <button
            class={props.appView === "openclaw" ? "active" : ""}
            title="Claw Queue"
            aria-label="Claw Queue"
            onClick={() => props.setAppView("openclaw")}
          >
            <Icon name="list-checks" />
            <span>Claw Queue</span>
          </button>
          <button
            title="Admin"
            aria-label="Admin"
            disabled={!canOwn(user)}
            onClick={() => props.openDrawer("admin")}
          >
            <Icon name="settings" />
            <span>Admin</span>
          </button>
          <button
            title="Sessions"
            aria-label="Sessions"
            onClick={() => props.openSessionGrid(null)}
          >
            <Icon name="terminal" />
            <span>Sessions</span>
          </button>
        </div>
        <div class="spacer" />
        <button
          class="theme-toggle"
          title={`Switch to ${props.theme === "dark" ? "light" : "dark"} mode`}
          aria-label={`Switch to ${props.theme === "dark" ? "light" : "dark"} mode`}
          onClick={() => props.setTheme(props.theme === "dark" ? "light" : "dark")}
        >
          <Icon name={props.theme === "dark" ? "sun" : "moon"} />
        </button>
        <button title="Spec" aria-label="Spec" onClick={() => (location.href = "/docs/spec")}>
          <Icon name="book-open" />
        </button>
      </aside>
      <main class="shell">
        <section class="top">
          <div class="title">
            <h1>
              {props.appView === "board"
                ? "Board"
                : props.appView === "openclaw"
                  ? "Claw Queue"
                  : productName}
            </h1>
            <p>
              {props.appView === "board"
                ? "Prompt cards and run attempts, separated from the live crabbox fleet."
                : props.appView === "openclaw"
                  ? "ClawSweeper-screened issues, Codex handoff, PR readiness, and maintainer review notes."
                  : "All visible Codex crabboxes grouped by person, with SSH, WebVNC, and OpenClaw supervision."}
            </p>
          </div>
          <button
            class="ghost user-chip"
            onClick={props.signedIn ? props.logout : props.beginLogin}
          >
            {userLabel}
          </button>
        </section>
        <DevIdentityPanel
          hidden={!props.authMethods.devIdentity || !props.signedIn}
          user={user}
          onDevIdentity={props.devIdentityLogin}
        />
        {props.appView === "board" ? (
          <BoardPage user={user} {...props} />
        ) : props.appView === "openclaw" ? (
          <OpenClawPage user={user} {...props} />
        ) : (
          <FleetPage
            active={active}
            queue={queue}
            review={review}
            cli={cli}
            userLabel={userLabel}
            {...props}
          />
        )}
      </main>
    </div>
  );
}

function sessionOwner(session) {
  return session.owner || session.operator || "unassigned";
}

function sessionOwnerLabel(owner) {
  return String(owner || "unassigned").replace(/^github:/, "@");
}

function groupedFleetSessions(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const owner = sessionOwner(session);
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(session);
  }
  return [...groups.entries()]
    .map(([owner, items]) => [
      owner,
      [...items].sort(
        (a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0),
      ),
    ])
    .sort((a, b) => {
      const activeDelta = activeFleetCount(b[1]) - activeFleetCount(a[1]);
      return activeDelta || sessionOwnerLabel(a[0]).localeCompare(sessionOwnerLabel(b[0]));
    });
}

function activeFleetCount(sessions) {
  return sessions.filter((session) => !isDeadInteractiveSession(session)).length;
}

function BoardPage(props) {
  return (
    <section class="board-page" aria-label="Crabfleet board page">
      <section class="toolbar">
        <div class="search-wrap">
          <input
            type="search"
            placeholder="Search cards, repos, runs, #76552"
            value={props.search}
            onInput={(event) => props.setSearch(event.currentTarget.value)}
          />
          <RefPreview
            preview={props.refPreview}
            canCreate={canMaintain(props.user)}
            onCreate={props.createRefCard}
          />
        </div>
        <div class="segmented" aria-label="Board filter">
          {["all", "mine", "hot"].map((key) => (
            <button
              class={props.filter === key ? "active" : ""}
              onClick={() => props.setFilter(key)}
            >
              {key === "all" ? "All" : key === "mine" ? "Mine" : "Live"}
            </button>
          ))}
        </div>
        <button
          class="primary"
          disabled={!canMaintain(props.user)}
          onClick={() => props.openDrawer("card")}
        >
          New card
        </button>
        <button disabled={!canMaintain(props.user)} onClick={() => props.openDrawer("interactive")}>
          New crabbox
        </button>
        <button disabled={!canOwn(props.user)} onClick={() => props.openDrawer("admin")}>
          Admin
        </button>
      </section>
      <Board {...props} />
    </section>
  );
}

function OpenClawPage(props) {
  const workflow = props.openClawState.data;
  const preferences = workflow?.preferences;
  const governor = workflow?.governor;
  const queues = workflow?.queues || [];
  const pullRequests = workflow?.pullRequests?.items || [];
  const [actionError, setActionError] = useState("");
  const [busyIssue, setBusyIssue] = useState(null);
  const canCreate = canMaintain(props.user) && Boolean(governor?.canStartNewWork);
  const canStartWork = Boolean(governor?.canStartNewWork);
  async function handleTrackCandidate(candidate) {
    setActionError("");
    try {
      await props.trackOpenClawCandidateWork(candidate);
    } catch (error) {
      setActionError(error.message || "Could not track local Codex work");
    }
  }
  async function handleStartCandidate(candidate) {
    setActionError("");
    try {
      await props.startOpenClawCodexWork(candidate);
    } catch (error) {
      setActionError(error.message || "Could not start local Codex");
    }
  }
  async function handleCreateCandidate(candidate) {
    setActionError("");
    setBusyIssue(candidate.number);
    try {
      await props.createOpenClawCandidateCard(candidate);
    } catch (error) {
      setActionError(error.message || "Could not create card");
    } finally {
      setBusyIssue(null);
    }
  }
  return (
    <section class="openclaw-page" aria-label="Claw Queue">
      <section class="openclaw-toolbar">
        <div>
          <div class="section-kicker">WORK QUEUE</div>
          <h2>{workflow?.repo || "openclaw/openclaw"}</h2>
        </div>
        <button onClick={() => props.loadOpenClawWorkflow()} disabled={props.openClawState.loading}>
          <Icon name="refresh-cw" />
          Refresh
        </button>
      </section>
      {props.openClawState.error ? (
        <div class="workflow-banner error">{props.openClawState.error}</div>
      ) : null}
      {actionError ? <div class="workflow-banner error">{actionError}</div> : null}
      <section class="openclaw-summary">
        <Metric
          label="Open PRs"
          value={governor ? `${governor.openPrCount}/${governor.activeOpenPrLimit}` : "-"}
        />
        <Metric
          label="Usage drop"
          value={
            governor?.usageDrop === null || governor?.usageDrop === undefined
              ? "-"
              : `${governor.usageDrop}/${governor.usageLimit}`
          }
        />
        <Metric label="Workers" value={preferences?.maxParallelWorkers ?? "-"} />
        <Metric label="New work" value={governor?.canStartNewWork ? "Allowed" : "Paused"} />
      </section>
      {governor?.reasons?.length ? (
        <div class="workflow-banner">{governor.reasons.join(" ")}</div>
      ) : null}
      <OpenClawCommandCenter
        workflow={workflow}
        workflowError={props.openClawState.error}
        queues={queues}
        runner={props.openClawRunner}
        preferences={preferences}
        governor={governor}
        canCreate={canCreate}
        canStartWork={canStartWork}
        busyIssue={busyIssue}
        onRefresh={props.loadOpenClawWorkflow}
        onCopyPrompt={props.copyOpenClawCandidatePrompt}
        onTrack={handleTrackCandidate}
        onStartCodex={handleStartCandidate}
        onCreate={handleCreateCandidate}
      />
      <OpenClawPreferencesPanel
        preferences={preferences}
        loading={props.openClawState.loading}
        onSave={props.updateOpenClawPreferences}
      />
      <OpenClawRunnerPanel
        runner={props.openClawRunner}
        preferences={preferences}
        onChange={props.updateOpenClawRunnerSettings}
        onCheck={props.checkOpenClawRunner}
      />
      <OpenClawWorkerRunway
        queues={queues}
        runner={props.openClawRunner}
        preferences={preferences}
        canCreate={canCreate}
        canStartWork={canStartWork}
        busyIssue={busyIssue}
        onCopyPrompt={props.copyOpenClawCandidatePrompt}
        onTrack={handleTrackCandidate}
        onStartCodex={handleStartCandidate}
        onCreate={handleCreateCandidate}
      />
      <OpenClawActiveWorkPanel
        runner={props.openClawRunner}
        onRefresh={props.refreshOpenClawRunnerRuns}
        onUpdate={props.updateOpenClawRunnerRun}
      />
      <section class="openclaw-grid">
        <div class="openclaw-main">
          <section class="workflow-section">
            <header class="workflow-section-head">
              <div>
                <div class="section-kicker">QUEUES</div>
                <h2>ClawSweeper-screened issues</h2>
              </div>
            </header>
            {queues.length ? (
              queues.map((queue) => (
                <OpenClawQueue
                  key={queue.definition.id}
                  queue={queue}
                  canCreate={canCreate}
                  canStartWork={canStartWork}
                  runner={props.openClawRunner}
                  busyIssue={busyIssue}
                  onCopyPrompt={props.copyOpenClawCandidatePrompt}
                  onTrack={handleTrackCandidate}
                  onStartCodex={handleStartCandidate}
                  onCreate={handleCreateCandidate}
                />
              ))
            ) : (
              <div class="empty">No queue data loaded.</div>
            )}
          </section>
        </div>
        <aside class="openclaw-side">
          <OpenClawPullRequests
            pullRequests={pullRequests}
            error={workflow?.pullRequests?.error}
            handoffText={props.openClawState.handoffText}
            onHandoff={props.createOpenClawHandoff}
          />
        </aside>
      </section>
    </section>
  );
}

function OpenClawPreferencesPanel({ preferences, loading, onSave }) {
  const [draft, setDraft] = useState(() => openClawPreferenceDraft(preferences));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDraft(openClawPreferenceDraft(preferences));
  }, [
    preferences?.updatedAt,
    preferences?.targetRepo,
    preferences?.githubLogin,
    preferences?.minimumIssueAgeHours,
  ]);
  if (!preferences) return <div class="openclaw-settings skeleton">Loading settings...</div>;
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const now = Date.now();
      const weeklyRemainingBaseline = nullableFormNumber(draft.weeklyRemainingBaseline);
      const weeklyRemainingCurrent = nullableFormNumber(draft.weeklyRemainingCurrent);
      const usageWindowActive =
        preferences.usageWindowStartedAt &&
        now - preferences.usageWindowStartedAt <= 24 * 60 * 60 * 1000;
      await onSave({
        roleMode: draft.roleMode,
        targetRepo: draft.targetRepo,
        githubLogin: draft.githubLogin,
        activeOpenPrLimit: Number(draft.activeOpenPrLimit),
        dailyUsageDropLimit: Number(draft.dailyUsageDropLimit),
        maxParallelWorkers: Number(draft.maxParallelWorkers),
        minimumIssueAgeHours: Number(draft.minimumIssueAgeHours),
        weeklyRemainingBaseline,
        weeklyRemainingCurrent,
        usageWindowStartedAt:
          weeklyRemainingBaseline === null && weeklyRemainingCurrent === null
            ? null
            : usageWindowActive
              ? preferences.usageWindowStartedAt
              : now,
      });
    } finally {
      setBusy(false);
    }
  }
  const disabled = busy || loading;
  return (
    <form class="openclaw-settings" onSubmit={submit}>
      <label>
        <LabelText
          text="Role"
          help="Chooses contributor, trial-maintainer, or maintainer queue rules. Save reloads the queues."
        />
        <select
          value={draft.roleMode}
          onInput={(event) => setDraft({ ...draft, roleMode: event.currentTarget.value })}
        >
          <option value="trial_maintainer">Trial maintainer</option>
          <option value="contributor">Contributor</option>
          <option value="maintainer">Maintainer</option>
        </select>
      </label>
      <label>
        <LabelText
          text="Repo"
          help="GitHub owner/repo to search for ClawSweeper-screened issues when you save."
        />
        <input
          value={draft.targetRepo}
          placeholder="openclaw/openclaw"
          onInput={(event) => setDraft({ ...draft, targetRepo: event.currentTarget.value })}
        />
      </label>
      <label>
        <LabelText
          text="GitHub login"
          help="GitHub username used to monitor your authored open PRs. It is not an issue search term."
        />
        <input
          value={draft.githubLogin}
          placeholder="brokemac79"
          onInput={(event) => setDraft({ ...draft, githubLogin: event.currentTarget.value })}
        />
      </label>
      <label>
        <LabelText
          text="Open PR limit"
          help="Personal cap for authored open PRs. At or above this number, new work is paused."
        />
        <input
          type="number"
          min="1"
          max="20"
          value={draft.activeOpenPrLimit}
          onInput={(event) => setDraft({ ...draft, activeOpenPrLimit: event.currentTarget.value })}
        />
      </label>
      <label>
        <LabelText
          text="Usage limit"
          help="Weekly usage percentage-point drop allowed in the current 24-hour window."
        />
        <input
          type="number"
          min="1"
          max="25"
          value={draft.dailyUsageDropLimit}
          onInput={(event) =>
            setDraft({ ...draft, dailyUsageDropLimit: event.currentTarget.value })
          }
        />
      </label>
      <label>
        <LabelText
          text="Workers"
          help="Preferred parallel worker limit. It does not start new work by itself yet."
        />
        <input
          type="number"
          min="1"
          max="8"
          value={draft.maxParallelWorkers}
          onInput={(event) => setDraft({ ...draft, maxParallelWorkers: event.currentTarget.value })}
        />
      </label>
      <label>
        <LabelText
          text="Min issue age"
          help="Hours an issue must exist before Start Codex is enabled. Use 0 for fork or dummy testing."
        />
        <input
          type="number"
          min="0"
          max="168"
          value={draft.minimumIssueAgeHours}
          onInput={(event) =>
            setDraft({ ...draft, minimumIssueAgeHours: event.currentTarget.value })
          }
        />
      </label>
      <label>
        <LabelText
          text="Weekly baseline"
          help="Starting weekly usage remaining percentage for the 24-hour budget window."
        />
        <input
          type="number"
          min="0"
          max="100"
          value={draft.weeklyRemainingBaseline}
          onInput={(event) =>
            setDraft({ ...draft, weeklyRemainingBaseline: event.currentTarget.value })
          }
        />
      </label>
      <label>
        <LabelText
          text="Weekly current"
          help="Current weekly usage remaining percentage. Lower than baseline counts as usage drop."
        />
        <input
          type="number"
          min="0"
          max="100"
          value={draft.weeklyRemainingCurrent}
          onInput={(event) =>
            setDraft({ ...draft, weeklyRemainingCurrent: event.currentTarget.value })
          }
        />
      </label>
      <button class="primary" type="submit" disabled={disabled}>
        {busy ? "Saving..." : "Save"}
      </button>
    </form>
  );
}

function OpenClawRunnerPanel({ runner, preferences, onChange, onCheck }) {
  const status = runner?.status || "unknown";
  const command = openClawRunnerCommand(runner, preferences);
  return (
    <section class="openclaw-runner">
      <div>
        <div class="section-kicker">CODEX HANDOFF</div>
        <h2>Local Codex bridge</h2>
      </div>
      <label>
        <LabelText text="Runner URL" help="Local bridge URL to test or use for Start Codex." />
        <input
          value={runner?.url || defaultOpenClawRunnerUrl}
          onInput={(event) => onChange({ url: event.currentTarget.value })}
        />
      </label>
      <label>
        <LabelText text="Token" help="Bearer token printed by the local runner command." />
        <input
          type="password"
          value={runner?.token || ""}
          placeholder="Required if runner started with a token"
          onInput={(event) => onChange({ token: event.currentTarget.value })}
        />
      </label>
      <div class="runner-actions">
        <span class={`chip ${status === "connected" ? "ok" : status === "error" ? "danger" : ""}`}>
          {status}
        </span>
        <button type="button" onClick={() => Promise.resolve(onCheck()).catch(() => {})}>
          Test
        </button>
        <button type="button" onClick={() => copyText(command)}>
          <Icon name="copy" />
          Runner command
        </button>
      </div>
      {runner?.error ? <div class="workflow-banner error">{runner.error}</div> : null}
      {runner?.info?.dryRun ? (
        <div class="workflow-banner">
          Dry-run bridge: Start Codex records prompts and active-work rows without launching Codex.
        </div>
      ) : null}
      {runner?.lastRun ? (
        <div class="workflow-banner">
          Started issue #{runner.lastRun.issueNumber || runner.lastRun.issue_number}:{" "}
          {runner.lastRun.threadId ||
            runner.lastRun.sessionId ||
            runner.lastRun.id ||
            "runner accepted"}
        </div>
      ) : null}
    </section>
  );
}

function OpenClawCommandCenter({
  workflow,
  workflowError,
  queues,
  runner,
  preferences,
  governor,
  canCreate,
  canStartWork,
  busyIssue,
  onRefresh,
  onCopyPrompt,
  onTrack,
  onStartCodex,
  onCreate,
}) {
  const plan = openClawCommandPlan({
    workflow,
    workflowError,
    queues,
    runner,
    preferences,
    governor,
  });
  const candidate = plan.candidate;
  const run = plan.run;
  return (
    <section class={`openclaw-command-center ${plan.tone}`} aria-label="Claw Queue command center">
      <div class="command-main">
        <div class="section-kicker">COMMAND CENTER</div>
        <div class="command-title-row">
          <span class={`command-pulse ${plan.tone}`} />
          <h2>{plan.headline}</h2>
        </div>
        <p>{plan.detail}</p>
        <div class="command-subline">
          {plan.subject ? <span>{plan.subject}</span> : null}
          {plan.meta.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </div>
      <div class="command-actions">
        {run ? (
          <>
            <button
              type="button"
              class="primary"
              onClick={() => copyText(openClawRunResumePrompt(run))}
            >
              <Icon name="message-square-text" />
              Resume
            </button>
            <button type="button" onClick={() => copyText(openClawRunHandoff(run))}>
              <Icon name="send" />
              Handoff
            </button>
            <button type="button" onClick={() => copyText(openClawRunNote(run))}>
              <Icon name="copy" />
              Note
            </button>
          </>
        ) : candidate ? (
          <>
            <button
              type="button"
              class="primary"
              title={openClawStartDisabledReason(candidate, canStartWork, runner)}
              disabled={
                runner?.status !== "connected" ||
                !canStartWork ||
                !candidate.signals.readyForPickup ||
                openClawRunnerStartCapacityReached(runner) ||
                runner?.startingIssue === candidate.number
              }
              onClick={() => onStartCodex(candidate)}
            >
              <Icon name="square-terminal" />
              {runner?.startingIssue === candidate.number ? "Starting" : "Start"}
            </button>
            <button
              type="button"
              title={openClawTrackDisabledReason(candidate, runner)}
              disabled={
                runner?.status !== "connected" ||
                !candidate.signals.readyForPickup ||
                runner?.trackingIssue === candidate.number
              }
              onClick={() => onTrack(candidate)}
            >
              <Icon name="list-checks" />
              {runner?.trackingIssue === candidate.number ? "Tracking" : "Track"}
            </button>
            <button type="button" onClick={() => onCopyPrompt(candidate)}>
              <Icon name="copy" />
              Prompt
            </button>
            <button
              type="button"
              disabled={
                !canCreate || !candidate.signals.readyForPickup || busyIssue === candidate.number
              }
              onClick={() => onCreate(candidate)}
            >
              {busyIssue === candidate.number ? "Creating" : "Card"}
            </button>
          </>
        ) : (
          <>
            <button type="button" class="primary" onClick={() => onRefresh()}>
              <Icon name="refresh-cw" />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => copyText(openClawWorkerRunwayBrief(plan.runway, runner))}
            >
              <Icon name="clipboard-list" />
              Lane plan
            </button>
          </>
        )}
      </div>
      <div class="command-gates" aria-label="Claw Queue gates">
        {plan.gates.map((gate) => (
          <div class={`command-gate ${gate.tone}`} key={gate.label}>
            <span>{gate.label}</span>
            <strong>{gate.value}</strong>
            <small>{gate.detail}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function OpenClawWorkerRunway({
  queues,
  runner,
  preferences,
  canCreate,
  canStartWork,
  busyIssue,
  onCopyPrompt,
  onTrack,
  onStartCodex,
  onCreate,
}) {
  const runway = openClawWorkerRunway(queues, runner, preferences);
  const [copied, setCopied] = useState(false);
  async function copyPlan() {
    await copyText(openClawWorkerRunwayBrief(runway, runner));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }
  return (
    <section class="openclaw-worker-runway">
      <header class="workflow-section-head">
        <div>
          <div class="section-kicker">WORKER RUNWAY</div>
          <h2>Parallel plate planner</h2>
          <p>{runway.summary}</p>
        </div>
        <div class="runway-head-actions">
          <span class="chip">
            {runway.filled}/{runway.capacity} filled
          </span>
          <span class={`chip ${runway.empty ? "ok" : "warn"}`}>
            {runway.empty} open {runway.empty === 1 ? "lane" : "lanes"}
          </span>
          <button type="button" onClick={copyPlan}>
            <Icon name="clipboard-list" />
            {copied ? "Copied" : "Copy lane plan"}
          </button>
        </div>
      </header>
      {runway.bridgeWarning ? <div class="workflow-banner">{runway.bridgeWarning}</div> : null}
      <div class="worker-lanes">
        {runway.lanes.map((lane) => (
          <OpenClawWorkerLane
            key={lane.id}
            lane={lane}
            runner={runner}
            canCreate={canCreate}
            canStartWork={canStartWork}
            busyIssue={busyIssue}
            onCopyPrompt={onCopyPrompt}
            onTrack={onTrack}
            onStartCodex={onStartCodex}
            onCreate={onCreate}
          />
        ))}
      </div>
    </section>
  );
}

function OpenClawWorkerLane({
  lane,
  runner,
  canCreate,
  canStartWork,
  busyIssue,
  onCopyPrompt,
  onTrack,
  onStartCodex,
  onCreate,
}) {
  const prUrl = openClawValidPrUrl(lane.run?.prUrl);
  const priorityLabel = lane.candidate ? openClawCandidatePriorityLabel(lane.candidate) : null;
  return (
    <article class={`worker-lane ${lane.kind}`}>
      <header class="worker-lane-head">
        <span class="lane-number">{lane.index}</span>
        <div>
          <strong>{lane.title}</strong>
          <span>{lane.subtitle}</span>
        </div>
      </header>
      {lane.run ? (
        <div class="worker-lane-body">
          <a href={lane.run.issueUrl || "#"} target="_blank" rel="noreferrer">
            #{lane.run.issueNumber || "?"} {lane.run.title || "OpenClaw issue"}
          </a>
          <div class="candidate-meta">
            <span class={`chip ${openClawRunTone(lane.run)}`}>{openClawRunLabel(lane.run)}</span>
            {lane.run.queueId ? <span class="chip">{lane.run.queueId}</span> : null}
            {prUrl ? <span class="chip ok">PR linked</span> : null}
          </div>
          <p>{openClawRunNextAction(lane.run)}</p>
          <div class="worker-lane-actions">
            <button onClick={() => copyText(openClawRunResumePrompt(lane.run))}>
              <Icon name="message-square-text" />
              Resume
            </button>
            <button onClick={() => copyText(openClawRunHandoff(lane.run))}>
              <Icon name="send" />
              Handoff
            </button>
          </div>
        </div>
      ) : lane.candidate ? (
        <div class="worker-lane-body">
          <a href={lane.candidate.url} target="_blank" rel="noreferrer">
            #{lane.candidate.number} {lane.candidate.title}
          </a>
          <div class="candidate-meta">
            <span class="chip ok">eligible</span>
            {priorityLabel ? <span class="chip warn">{priorityLabel}</span> : null}
            <span class="chip">{lane.candidate.queueId}</span>
            {lane.candidate.signals.sourceRepro ? <span class="chip">source repro</span> : null}
            {lane.candidate.signals.currentMainRepro ? (
              <span class="chip">current main</span>
            ) : null}
          </div>
          <p>{openClawCandidateWhy(lane.candidate)}</p>
          <div class="worker-lane-actions">
            <button onClick={() => onCopyPrompt(lane.candidate)}>
              <Icon name="copy" />
              Prompt
            </button>
            <button
              title={openClawTrackDisabledReason(lane.candidate, runner)}
              disabled={
                runner?.status !== "connected" ||
                !lane.candidate.signals.readyForPickup ||
                runner?.trackingIssue === lane.candidate.number
              }
              onClick={() => onTrack(lane.candidate)}
            >
              <Icon name="list-checks" />
              {runner?.trackingIssue === lane.candidate.number ? "Tracking..." : "Track"}
            </button>
            <button
              title={openClawStartDisabledReason(lane.candidate, canStartWork, runner)}
              disabled={
                runner?.status !== "connected" ||
                !canStartWork ||
                !lane.candidate.signals.readyForPickup ||
                openClawRunnerStartCapacityReached(runner) ||
                runner?.startingIssue === lane.candidate.number
              }
              onClick={() => onStartCodex(lane.candidate)}
            >
              <Icon name="square-terminal" />
              {runner?.startingIssue === lane.candidate.number ? "Starting..." : "Start"}
            </button>
            <button
              class="primary"
              disabled={
                !canCreate ||
                !lane.candidate.signals.readyForPickup ||
                busyIssue === lane.candidate.number
              }
              onClick={() => onCreate(lane.candidate)}
            >
              {busyIssue === lane.candidate.number ? "Creating..." : "Card"}
            </button>
          </div>
        </div>
      ) : (
        <div class="worker-lane-empty">
          <Icon name="target" />
          <p>No eligible queue item for this lane yet.</p>
        </div>
      )}
    </article>
  );
}

function OpenClawActiveWorkPanel({ runner, onRefresh, onUpdate }) {
  const runs = Array.isArray(runner?.runs) ? runner.runs : [];
  const mission = openClawMissionControl(runs, runner);
  const readinessRadar = openClawReadinessRadar(runs);
  const activeCount = runs.filter((run) => openClawRunOpenPlate(run)).length;
  const maxActive = runner?.info?.maxActive || "-";
  const readyCount = runs.filter((run) => run?.status === "ready").length;
  const parkedCount = runs.filter((run) => run?.status === "parked").length;
  const inactiveRuns = runs.filter((run) => openClawRunInactive(run));
  const [busyRun, setBusyRun] = useState(null);
  const [actionError, setActionError] = useState("");
  const [prEditor, setPrEditor] = useState({ runId: null, value: "" });
  const [logViewer, setLogViewer] = useState({
    runId: null,
    loading: false,
    error: "",
    log: null,
  });
  const selectedLogRun = logViewer.runId
    ? runs.find((run) => run.id === logViewer.runId) || null
    : null;
  const selectedLogRunState = selectedLogRun
    ? `${selectedLogRun.id}:${selectedLogRun.status}:${selectedLogRun.updatedAt}:${selectedLogRun.finishedAt}`
    : "";
  useEffect(() => {
    if (!selectedLogRun || runner?.status !== "connected") return;
    let cancelled = false;
    async function refreshLog(silent = true) {
      setLogViewer((current) =>
        current.runId === selectedLogRun.id
          ? { ...current, loading: silent ? current.loading : true, error: "" }
          : current,
      );
      try {
        const result = await fetchOpenClawRunnerRunLog(runner, selectedLogRun);
        if (cancelled) return;
        setLogViewer((current) =>
          current.runId === selectedLogRun.id
            ? { ...current, loading: false, error: "", log: result.log }
            : current,
        );
      } catch (error) {
        if (cancelled) return;
        setLogViewer((current) =>
          current.runId === selectedLogRun.id
            ? {
                ...current,
                loading: false,
                error: error.message || "Could not load Codex log",
              }
            : current,
        );
      }
    }
    void refreshLog(true);
    if (!openClawRunActive(selectedLogRun)) {
      return () => {
        cancelled = true;
      };
    }
    const interval = setInterval(() => void refreshLog(true), 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedLogRunState, logViewer.runId, runner?.url, runner?.token, runner?.status]);
  async function openRunLog(run, silent = false) {
    setLogViewer((current) => ({
      runId: run.id,
      loading: !silent,
      error: "",
      log: current.runId === run.id ? current.log : null,
    }));
    try {
      const result = await fetchOpenClawRunnerRunLog(runner, run);
      setLogViewer((current) =>
        current.runId === run.id
          ? { ...current, loading: false, error: "", log: result.log }
          : current,
      );
    } catch (error) {
      setLogViewer((current) =>
        current.runId === run.id
          ? { ...current, loading: false, error: error.message || "Could not load Codex log" }
          : current,
      );
    }
  }
  async function update(run, patch) {
    setActionError("");
    setBusyRun(run.id);
    try {
      await onUpdate(run, patch);
    } catch (error) {
      setActionError(error.message || "Could not update active work");
      throw error;
    } finally {
      setBusyRun(null);
    }
  }
  async function archiveInactiveRuns() {
    setActionError("");
    setBusyRun("archive-inactive");
    try {
      for (const run of inactiveRuns) {
        await onUpdate(run, { status: "archive" });
      }
    } catch (error) {
      setActionError(error.message || "Could not archive inactive work");
    } finally {
      setBusyRun(null);
    }
  }
  function editPr(run) {
    setPrEditor({ runId: run.id, value: run?.prUrl || "" });
  }
  async function savePr(event, run) {
    event.preventDefault();
    const prUrl = openClawValidPrUrl(prEditor.value);
    if (prEditor.value.trim() && !prUrl) {
      setActionError("PR URL must be a https://github.com/owner/repo/pull/123 URL.");
      return;
    }
    try {
      await update(run, { prUrl });
      setPrEditor({ runId: null, value: "" });
    } catch {}
  }
  return (
    <section class="openclaw-active-work">
      <header class="workflow-section-head">
        <div>
          <div class="section-kicker">ACTIVE WORK</div>
          <h2>Codex issue runs</h2>
        </div>
        <div class="active-work-tools">
          <span class="chip">
            {activeCount}/{maxActive} active
          </span>
          <span class="chip ok">{readyCount} ready</span>
          <span class="chip warn">{parkedCount} parked</span>
          {inactiveRuns.length ? <span class="chip">{inactiveRuns.length} inactive</span> : null}
          {inactiveRuns.length ? (
            <button
              type="button"
              disabled={
                runner?.status !== "connected" ||
                runner?.runsLoading ||
                busyRun === "archive-inactive"
              }
              onClick={archiveInactiveRuns}
            >
              <Icon name="archive" />
              {busyRun === "archive-inactive" ? "Archiving..." : "Archive inactive"}
            </button>
          ) : null}
          <button
            type="button"
            disabled={runner?.status !== "connected" || runner?.runsLoading}
            onClick={() => Promise.resolve(onRefresh()).catch(() => {})}
          >
            <Icon name="refresh-cw" />
            {runner?.runsLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </header>
      {actionError ? <div class="workflow-banner error">{actionError}</div> : null}
      {runner?.runsError ? <div class="workflow-banner error">{runner.runsError}</div> : null}
      {runs.length ? (
        <section class="active-work-mission" aria-label="Active work command center">
          <div class="mission-focus">
            <div class="mission-focus-head">
              <span class={`chip ${mission.tone}`}>{mission.label}</span>
              <span class="chip">{mission.plateCount} plates</span>
            </div>
            <h3>{mission.headline}</h3>
            <p>{mission.detail}</p>
          </div>
          {mission.items.length ? (
            <div class="mission-stack">
              {mission.items.map((item) => (
                <button
                  type="button"
                  key={item.run.id}
                  onClick={() => copyText(openClawRunResumePrompt(item.run))}
                  title="Copy a Codex resume prompt for this plate"
                >
                  <span class={`mission-rank ${item.tone}`}>{item.rank}</span>
                  <span>
                    <strong>#{item.run.issueNumber || "?"}</strong>
                    {item.label}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          <div class="mission-actions">
            <button type="button" onClick={() => copyText(openClawActiveWorkBrief(runs, runner))}>
              <Icon name="clipboard-list" />
              Copy work brief
            </button>
            <button
              type="button"
              disabled={!mission.focusRun}
              onClick={() => copyText(openClawRunResumePrompt(mission.focusRun))}
            >
              <Icon name="message-square-text" />
              Copy focus prompt
            </button>
          </div>
        </section>
      ) : null}
      {runs.length ? (
        <section class="active-work-radar" aria-label="Active work closeout radar">
          {readinessRadar.map((item) => (
            <div class={`radar-cell ${item.tone}`} key={item.label}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <small>{item.detail}</small>
            </div>
          ))}
        </section>
      ) : null}
      {runs.length ? (
        <div class="active-work-list">
          {runs.slice(0, 12).map((run) => {
            const isLive = openClawRunActive(run);
            const checklist = openClawRunChecklist(run);
            const prUrl = openClawValidPrUrl(run?.prUrl);
            return (
              <article class="active-work-row" key={run.id}>
                <div class="active-work-main">
                  <a href={run.issueUrl || "#"} target="_blank" rel="noreferrer">
                    #{run.issueNumber || "?"} {run.title || "OpenClaw issue"}
                  </a>
                  <div class="candidate-meta">
                    <span class={`chip ${openClawRunTone(run)}`}>{openClawRunLabel(run)}</span>
                    {run.queueId ? <span class="chip">{run.queueId}</span> : null}
                    {run.source ? <span class="chip">{run.source}</span> : null}
                    {run.pid ? <span class="chip">pid {run.pid}</span> : null}
                    <span class="chip">{openClawRunWhen(run)}</span>
                  </div>
                  <div class="active-work-checklist" aria-label="OpenClaw readiness checklist">
                    {checklist.map((item) => (
                      <span
                        key={item.label}
                        class={`check-step ${item.done ? "done" : item.tone || ""}`}
                      >
                        {item.label}
                      </span>
                    ))}
                  </div>
                  <p class="active-work-next">{openClawRunNextAction(run)}</p>
                  {run.note ? <p class="active-work-note">{run.note}</p> : null}
                </div>
                <div class="active-work-detail">
                  {prUrl ? (
                    <a class="active-work-pr" href={prUrl} target="_blank" rel="noreferrer">
                      <Icon name="git-pull-request" />
                      PR linked
                    </a>
                  ) : null}
                  <code>{run.id}</code>
                  <div class="active-work-actions">
                    <button onClick={() => copyText(openClawRunResumePrompt(run))}>
                      <Icon name="message-square-text" />
                      Resume
                    </button>
                    <button onClick={() => copyText(openClawRunHandoff(run))}>
                      <Icon name="send" />
                      Handoff
                    </button>
                    <button disabled={busyRun === run.id} onClick={() => editPr(run)}>
                      <Icon name="git-pull-request" />
                      {prUrl ? "Edit PR" : "Link PR"}
                    </button>
                    <button onClick={() => copyText(openClawRunNote(run))}>Copy note</button>
                    {run.logPath ? (
                      <button onClick={() => copyText(run.logPath)}>Copy log</button>
                    ) : null}
                    <button
                      disabled={runner?.status !== "connected"}
                      onClick={() => openRunLog(run)}
                    >
                      <Icon name="terminal" />
                      {logViewer.runId === run.id ? "Watching" : "Watch log"}
                    </button>
                    <button
                      disabled={isLive || busyRun === run.id || run.status === "parked"}
                      onClick={() =>
                        update(run, {
                          status: "parked",
                          note: "Parked pending proof, Mantis, CI, or maintainer/reporter input.",
                        })
                      }
                    >
                      Park
                    </button>
                    <button
                      disabled={isLive || busyRun === run.id || run.status === "ready"}
                      onClick={() =>
                        update(run, {
                          status: "ready",
                          note: "Ready for maintainer look once PR/proof/CI/Codex review are linked.",
                        })
                      }
                    >
                      Ready
                    </button>
                    <button
                      disabled={isLive || busyRun === run.id}
                      onClick={() => update(run, { status: "archive" })}
                    >
                      Archive
                    </button>
                  </div>
                  {prEditor.runId === run.id ? (
                    <form class="active-work-pr-form" onSubmit={(event) => savePr(event, run)}>
                      <input
                        aria-label={`PR URL for #${run.issueNumber || "?"}`}
                        value={prEditor.value}
                        placeholder="https://github.com/openclaw/openclaw/pull/123"
                        onInput={(event) =>
                          setPrEditor({ runId: run.id, value: event.currentTarget.value })
                        }
                      />
                      <button type="submit" disabled={busyRun === run.id}>
                        Save PR
                      </button>
                      <button
                        type="button"
                        disabled={busyRun === run.id}
                        onClick={() => setPrEditor({ runId: null, value: "" })}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : null}
                </div>
                {logViewer.runId === run.id ? (
                  <OpenClawRunLogPanel
                    run={run}
                    log={logViewer.log}
                    loading={logViewer.loading}
                    error={logViewer.error}
                    onRefresh={() => openRunLog(run)}
                    onClose={() =>
                      setLogViewer({ runId: null, loading: false, error: "", log: null })
                    }
                  />
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <div class="empty">No Codex issue runs yet.</div>
      )}
    </section>
  );
}

function OpenClawRunLogPanel({ run, log, loading, error, onRefresh, onClose }) {
  const entries = Array.isArray(log?.entries) ? log.entries : [];
  return (
    <section class="active-run-log" aria-label={`Codex log for issue ${run.issueNumber || "?"}`}>
      <header class="active-run-log-head">
        <div>
          <span class="section-kicker">LIVE LOG</span>
          <strong>{run.id}</strong>
        </div>
        <div class="active-run-log-actions">
          <span class={`chip ${openClawRunActive(run) ? "warn" : "ok"}`}>
            {openClawRunActive(run) ? "polling" : "snapshot"}
          </span>
          <button type="button" disabled={loading} onClick={onRefresh}>
            <Icon name="refresh-cw" />
            {loading ? "Loading..." : "Refresh"}
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </header>
      {error ? <div class="workflow-banner error">{error}</div> : null}
      <div class="active-run-log-meta">
        <span>{log?.exists === false ? "No log file yet" : `${entries.length} events`}</span>
        {log?.truncated ? <span>tail view</span> : null}
        {log?.size ? <span>{formatBytes(log.size)}</span> : null}
        {log?.updatedAt ? (
          <span>updated {openClawRunWhen({ startedAt: log.updatedAt })}</span>
        ) : null}
      </div>
      <div class="active-run-log-stream">
        {entries.length ? (
          entries.map((entry) => (
            <article
              class={`run-log-entry ${openClawRunLogEntryTone(entry)}`}
              key={`${entry.index}-${entry.type}`}
            >
              <div class="run-log-entry-head">
                <span>{entry.label || entry.type || "Event"}</span>
                {entry.at ? <time>{entry.at}</time> : null}
              </div>
              <pre>{openClawRunLogEntryText(entry)}</pre>
            </article>
          ))
        ) : (
          <div class="empty">{loading ? "Loading Codex log..." : "No log entries yet."}</div>
        )}
      </div>
      {log?.path ? (
        <button class="terminal-command" type="button" onClick={() => copyText(log.path)}>
          <Icon name="copy" />
          <code>{log.path}</code>
        </button>
      ) : null}
    </section>
  );
}

function OpenClawQueue({
  queue,
  canCreate,
  canStartWork,
  runner,
  busyIssue,
  onCopyPrompt,
  onTrack,
  onStartCodex,
  onCreate,
}) {
  return (
    <section class="queue-block">
      <header class="queue-head">
        <div>
          <h3>{queue.definition.title}</h3>
          <p>{queue.definition.why}</p>
        </div>
        <span class="chip">{queue.totalCount}</span>
      </header>
      <code class="query-line">{queue.query}</code>
      {queue.error ? (
        <div class={`workflow-banner ${queue.candidates.length ? "" : "error"}`}>{queue.error}</div>
      ) : null}
      <div class="candidate-list">
        {queue.candidates.length ? (
          queue.candidates.map((candidate) => {
            const issueInWork = openClawRunnerHasIssueRun(runner, candidate.number, candidate.url);
            return (
              <article class="candidate-row" key={`${queue.definition.id}-${candidate.number}`}>
                <div class="candidate-main">
                  <a href={candidate.url} target="_blank" rel="noreferrer">
                    #{candidate.number} {candidate.title}
                  </a>
                  <div class="candidate-meta">
                    {candidate.author ? <span class="chip">@{candidate.author}</span> : null}
                    <span class={`chip ${candidate.signals.readyForPickup ? "ok" : "warn"}`}>
                      {candidate.signals.readyForPickup ? "ready" : candidate.signals.ageGate}
                    </span>
                    {candidate.signals.sourceRepro ? <span class="chip">source repro</span> : null}
                    {candidate.signals.currentMainRepro ? (
                      <span class="chip">current main</span>
                    ) : null}
                    {candidate.signals.needsLiveValidation ? (
                      <span class="chip warn">live proof</span>
                    ) : null}
                    {issueInWork ? <span class="chip warn">in work</span> : null}
                  </div>
                </div>
                <div class="candidate-actions">
                  <button onClick={() => window.open(candidate.url, "_blank", "noopener")}>
                    <Icon name="external-link" />
                  </button>
                  <button onClick={() => onCopyPrompt(candidate)}>
                    <Icon name="copy" />
                    Copy prompt
                  </button>
                  <button
                    title={openClawTrackDisabledReason(candidate, runner)}
                    disabled={
                      runner?.status !== "connected" ||
                      issueInWork ||
                      !candidate.signals.readyForPickup ||
                      runner?.trackingIssue === candidate.number
                    }
                    onClick={() => onTrack(candidate)}
                  >
                    <Icon name="list-checks" />
                    {issueInWork
                      ? "Tracked"
                      : runner?.trackingIssue === candidate.number
                        ? "Tracking..."
                        : "Track"}
                  </button>
                  <button
                    title={openClawStartDisabledReason(candidate, canStartWork, runner)}
                    disabled={
                      runner?.status !== "connected" ||
                      issueInWork ||
                      !canStartWork ||
                      !candidate.signals.readyForPickup ||
                      openClawRunnerStartCapacityReached(runner) ||
                      runner?.startingIssue === candidate.number
                    }
                    onClick={() => onStartCodex(candidate)}
                  >
                    <Icon name="square-terminal" />
                    {issueInWork
                      ? "In work"
                      : runner?.startingIssue === candidate.number
                        ? "Starting..."
                        : "Start Codex"}
                  </button>
                  <button
                    class="primary"
                    disabled={
                      !canCreate ||
                      issueInWork ||
                      !candidate.signals.readyForPickup ||
                      busyIssue === candidate.number
                    }
                    onClick={() => onCreate(candidate)}
                  >
                    {issueInWork
                      ? "On plate"
                      : busyIssue === candidate.number
                        ? "Creating..."
                        : "New card"}
                  </button>
                </div>
              </article>
            );
          })
        ) : (
          <div class="empty">No matching issues.</div>
        )}
      </div>
    </section>
  );
}

function OpenClawPullRequests({ pullRequests, error, handoffText, onHandoff }) {
  const [busyPr, setBusyPr] = useState(null);
  return (
    <section class="workflow-section pr-monitor">
      <header class="workflow-section-head">
        <div>
          <div class="section-kicker">PR MONITOR</div>
          <h2>Authored open PRs</h2>
        </div>
      </header>
      {error ? <div class="workflow-banner error">{error}</div> : null}
      <div class="pr-list">
        {pullRequests.length ? (
          pullRequests.map((pr) => (
            <article class="pr-row" key={pr.number}>
              <a href={pr.url} target="_blank" rel="noreferrer">
                #{pr.number} {pr.title}
              </a>
              <div class="candidate-meta">
                <span class={`chip ${openClawPrStatusTone(pr.signals)}`}>
                  {openClawPrStatusLabel(pr.signals)}
                </span>
                <span
                  class={`chip ${pr.checks.state === "green" ? "ok" : pr.checks.state === "failing" ? "danger" : "warn"}`}
                >
                  CI {pr.checks.state}
                </span>
                {pr.signals.mergeReady ? <span class="chip ok">merge ready</span> : null}
                {pr.signals.clawsweeperHumanReview ? (
                  <span class="chip warn">human review</span>
                ) : null}
                {pr.signals.needsProof ? <span class="chip danger">needs proof</span> : null}
                {pr.signals.waitingOnAuthor ? (
                  <span class="chip warn">waiting on author</span>
                ) : null}
                {pr.signals.proofSufficient ? <span class="chip ok">proof sufficient</span> : null}
                {pr.checks.mantis ? <span class="chip">Mantis {pr.checks.mantis}</span> : null}
              </div>
              {pr.checks.failing.length ? (
                <p class="pr-detail">Failing: {pr.checks.failing.slice(0, 3).join(", ")}</p>
              ) : pr.checks.pending.length ? (
                <p class="pr-detail">Pending: {pr.checks.pending.slice(0, 3).join(", ")}</p>
              ) : null}
              <button
                disabled={busyPr === pr.number}
                onClick={async () => {
                  setBusyPr(pr.number);
                  try {
                    const text = await onHandoff({
                      prUrl: pr.url,
                      title: `#${pr.number} ${pr.title}`,
                      summary: "Focused fix is ready for maintainer review.",
                      proof: pr.signals.proofSufficient
                        ? "ClawSweeper marked proof sufficient; local validation and Codex review completed."
                        : "Local validation and Codex review completed.",
                      ci: `CI ${pr.checks.state}`,
                      clawsweeper: openClawPrStatusLabel(pr.signals),
                    });
                    await copyText(text);
                  } finally {
                    setBusyPr(null);
                  }
                }}
              >
                <Icon name="message-square" />
                Handoff
              </button>
            </article>
          ))
        ) : (
          <div class="empty">No authored open PRs found.</div>
        )}
      </div>
      <label class="handoff-box">
        Discord handoff
        <textarea readOnly value={handoffText} placeholder="Generated handoff text appears here" />
      </label>
      <button disabled={!handoffText} onClick={() => copyText(handoffText)}>
        <Icon name="copy" />
        Copy
      </button>
    </section>
  );
}

function openClawPrStatusLabel(signals) {
  if (signals?.statusLabel) return signals.statusLabel;
  if (signals?.readyForMaintainer || signals?.mergeReady) return "ready";
  if (signals?.clawsweeperHumanReview) return "human review";
  if (signals?.needsProof) return "needs proof";
  if (signals?.waitingOnAuthor) return "waiting on author";
  if (signals?.reReviewLoop) return "re-review loop";
  return "needs action";
}

function openClawPrStatusTone(signals) {
  if (signals?.readyForMaintainer || signals?.mergeReady) return "ok";
  if (signals?.needsProof) return "danger";
  return "warn";
}

function LabelText({ text, help }) {
  return (
    <span class="label-text">
      {text}
      <span
        class="help-dot"
        title={help}
        aria-label={`${text}: ${help}`}
        data-help={help}
        tabIndex="0"
      >
        ?
      </span>
    </span>
  );
}

function openClawPreferenceDraft(preferences) {
  return {
    roleMode: preferences?.roleMode || "trial_maintainer",
    targetRepo: preferences?.targetRepo || "openclaw/openclaw",
    githubLogin: preferences?.githubLogin || "",
    activeOpenPrLimit: String(preferences?.activeOpenPrLimit ?? 10),
    dailyUsageDropLimit: String(preferences?.dailyUsageDropLimit ?? 5),
    maxParallelWorkers: String(preferences?.maxParallelWorkers ?? 2),
    minimumIssueAgeHours: String(preferences?.minimumIssueAgeHours ?? 6),
    weeklyRemainingBaseline:
      preferences?.weeklyRemainingBaseline === null ||
      preferences?.weeklyRemainingBaseline === undefined
        ? ""
        : String(preferences.weeklyRemainingBaseline),
    weeklyRemainingCurrent:
      preferences?.weeklyRemainingCurrent === null ||
      preferences?.weeklyRemainingCurrent === undefined
        ? ""
        : String(preferences.weeklyRemainingCurrent),
  };
}

function openClawStartDisabledReason(candidate, canStartWork, runner) {
  if (runner?.status !== "connected") return "Connect the local Codex bridge first.";
  if (openClawRunnerHasIssueRun(runner, candidate?.number, candidate?.url)) {
    return "This issue is already on Active Work.";
  }
  if (!canStartWork) return "New work is paused by your Open PR or usage limits.";
  if (candidate?.signals?.ageGate === "too-new") {
    return "Waiting for the configured minimum issue age. Set Min issue age to 0 for fork or dummy testing.";
  }
  if (!candidate?.signals?.readyForPickup) {
    return "This issue is not ready for pickup under the current ClawSweeper labels.";
  }
  if (openClawRunnerStartCapacityReached(runner)) {
    return "The local Codex bridge is already at its --max-active limit.";
  }
  if (runner?.startingIssue === candidate?.number) return "Starting local Codex work.";
  return "Start local Codex with this issue prompt.";
}

function openClawTrackDisabledReason(candidate, runner) {
  if (runner?.status !== "connected") return "Connect the local Codex bridge first.";
  if (openClawRunnerHasIssueRun(runner, candidate?.number, candidate?.url)) {
    return "This issue is already on Active Work.";
  }
  if (candidate?.signals?.ageGate === "too-new") {
    return "Waiting for the configured minimum issue age. Set Min issue age to 0 for fork or dummy testing.";
  }
  if (!candidate?.signals?.readyForPickup) {
    return "This issue is not ready for pickup under the current ClawSweeper labels.";
  }
  if (runner?.trackingIssue === candidate?.number) return "Tracking this issue.";
  return "Track this issue as manually started work.";
}

function openClawCandidatePrompt(candidate) {
  const prompt = String(candidate?.workPrompt || "");
  if (openClawPromptLooksComplete(prompt)) return prompt;
  return buildOpenClawIssuePrompt({
    ...candidate,
    author: candidate?.author || null,
    createdAt: candidate?.createdAt || null,
    labels: Array.isArray(candidate?.labels) ? candidate.labels : [],
    number: Number(candidate?.number) || 0,
    queueId: candidate?.queueId || "openclaw",
    signals: candidate?.signals || {},
    title: candidate?.title || "OpenClaw issue",
    updatedAt: candidate?.updatedAt || null,
    url: candidate?.url || "https://github.com/openclaw/openclaw/issues",
  });
}

function openClawPromptLooksComplete(prompt) {
  return (
    /AGENTS\.md/.test(prompt) &&
    /CONTRIBUTING\.md/.test(prompt) &&
    /codex review/i.test(prompt) &&
    /ready for maintainer look/i.test(prompt)
  );
}

function loadOpenClawRunnerSettings() {
  try {
    const savedUrl = localStorage.getItem(openClawRunnerUrlStorageKey);
    const savedToken = localStorage.getItem(openClawRunnerTokenStorageKey) || "";
    return {
      url: savedUrl ? String(savedUrl) : defaultOpenClawRunnerUrl,
      token: savedToken,
      saved: Boolean(savedUrl || savedToken),
      status: "unknown",
      error: "",
      info: null,
      lastRun: null,
      runs: [],
      runsLoading: false,
      runsError: "",
      startingIssue: null,
      trackingIssue: null,
    };
  } catch {
    return {
      url: defaultOpenClawRunnerUrl,
      token: "",
      saved: false,
      status: "unknown",
      error: "",
      info: null,
      lastRun: null,
      runs: [],
      runsLoading: false,
      runsError: "",
      startingIssue: null,
      trackingIssue: null,
    };
  }
}

function openClawRunnerHasIssueRun(runner, issueNumber, issueUrl) {
  const issueKey = openClawIssueKey(issueNumber, issueUrl);
  if (!issueKey) return false;
  return Array.isArray(runner?.runs)
    ? runner.runs.some((run) => openClawIssueKey(run?.issueNumber, run?.issueUrl) === issueKey)
    : false;
}

function openClawIssueKey(issueNumber, issueUrl) {
  const normalizedNumber = Number(issueNumber);
  let parsedIssueNumber = Number.isFinite(normalizedNumber) ? Math.trunc(normalizedNumber) : null;
  try {
    const url = new URL(String(issueUrl || ""));
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 4 && parts[2] === "issues") {
      const urlIssueNumber = Number(parts[3]);
      parsedIssueNumber = Number.isFinite(urlIssueNumber)
        ? Math.trunc(urlIssueNumber)
        : parsedIssueNumber;
      if (parsedIssueNumber) {
        return `${url.hostname.toLowerCase()}/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}#${parsedIssueNumber}`;
      }
    }
  } catch {}
  if (parsedIssueNumber) return `#${parsedIssueNumber}`;
  return "";
}

function resolveRunnerUrl(value) {
  const text = String(value || "").trim();
  if (!text) return defaultOpenClawRunnerUrl;
  const candidate = text.includes("://") ? text : `http://${text}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Runner URL must be a localhost, 127.0.0.1, or ::1 HTTP URL.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(url.protocol) || !isLoopbackRunnerHost(hostname)) {
    throw new Error("Runner URL must be a localhost, 127.0.0.1, or ::1 HTTP URL.");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function isLoopbackRunnerHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function openClawRunnerHeaders(runner) {
  const headers = { accept: "application/json" };
  if (runner?.token) headers.authorization = `Bearer ${runner.token}`;
  return headers;
}

async function fetchOpenClawRunnerRuns(runner) {
  const response = await fetch(`${resolveRunnerUrl(runner?.url)}/runs`, {
    headers: openClawRunnerHeaders(runner),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false || !Array.isArray(body.runs)) {
    throw new Error(body.error || `Runner returned ${response.status}`);
  }
  return body.runs;
}

async function fetchOpenClawRunnerRunLog(runner, run) {
  const response = await fetch(
    `${resolveRunnerUrl(runner?.url)}/runs/${encodeURIComponent(run.id)}/log?entries=180&bytes=260000`,
    {
      headers: openClawRunnerHeaders(runner),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false || !body.log) {
    throw new Error(body.error || `Runner returned ${response.status}`);
  }
  return body;
}

function openClawRunnerCommand(runner, preferences) {
  let port = "4545";
  try {
    port = new URL(resolveRunnerUrl(runner?.url)).port || port;
  } catch {}
  const token = String(runner?.token || "").trim();
  const tokenArg = token ? ` --token ${token}` : "";
  const maxActive = Math.max(1, Math.min(16, Number(preferences?.maxParallelWorkers) || 1));
  return `pnpm openclaw:runner -- --workspace C:\\path\\to\\openclaw --port ${port} --max-active ${maxActive}${tokenArg}`;
}

function openClawRunActive(run) {
  return run?.status === "starting" || run?.status === "running";
}

function openClawRunOpenPlate(run) {
  return (
    run &&
    !run.archivedAt &&
    !openClawRunInactive(run) &&
    run.status !== "ready" &&
    run.status !== "parked"
  );
}

function openClawRunnerStartCapacityReached(runner) {
  if (runner?.status !== "connected") return false;
  const maxActive = Number(runner?.info?.maxActive || 0) || 0;
  if (maxActive <= 0) return false;
  const reportedActive = Number(runner?.info?.active || 0) || 0;
  const visibleLiveRuns = Array.isArray(runner?.runs)
    ? runner.runs.filter(
        (run) => run && !run.finishedAt && ["starting", "running"].includes(run.status),
      ).length
    : 0;
  return Math.max(reportedActive, visibleLiveRuns) >= maxActive;
}

function openClawRunInactive(run) {
  return ["completed", "dry-run", "failed", "stale"].includes(run?.status);
}

function openClawRunTone(run) {
  if (run?.status === "completed" || run?.status === "dry-run" || run?.status === "ready") {
    return "ok";
  }
  if (run?.status === "failed" || run?.status === "stale") return "danger";
  if (openClawRunActive(run) || run?.status === "tracked" || run?.status === "parked") {
    return "warn";
  }
  return "";
}

function openClawRunLogEntryTone(entry) {
  const type = String(entry?.type || "").toLowerCase();
  const text = String(entry?.text || "");
  if (type === "exit") {
    if (/\bsignal=/i.test(text) || /code=(?!0\b)/i.test(text)) return "danger";
    return "ok";
  }
  if (type.includes("error")) return "danger";
  if (type === "stderr" || /warning|timeout|retry/i.test(text)) return "warn";
  if (type.includes("agent")) return "ok";
  return "";
}

function openClawRunLogEntryText(entry) {
  const direct = String(entry?.text || entry?.message || "").trim();
  if (direct) return direct;
  try {
    return JSON.stringify(entry, null, 2);
  } catch {
    return "No event details.";
  }
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let amount = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function openClawRunLabel(run) {
  return String(run?.status || "unknown").replace(/-/g, " ");
}

function openClawRunWhen(run) {
  const timestamp = run?.finishedAt || run?.startedAt;
  if (!timestamp) return "unknown";
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return new Date(parsed).toLocaleDateString();
}

function openClawRunNextAction(run) {
  switch (run?.status) {
    case "running":
    case "starting":
      return "Watch Codex, then open/update the PR only after proof and Codex review.";
    case "tracked":
      return "External work is on your plate; keep this row until a PR, blocker, or ready handoff exists.";
    case "dry-run":
      return "Dry run captured the prompt; restart the bridge without --dry-run for real execution.";
    case "completed":
      return "Check proof, PR state, CI, and ClawSweeper; then mark ready or park.";
    case "ready":
      return "Ready for maintainer look; use the handoff text once the PR/proof links are in place.";
    case "parked":
      return "Parked until missing proof, Mantis, CI, or a maintainer/reporter decision is available.";
    case "failed":
      return "Open the log, fix the setup or prompt problem, then retry or park.";
    case "stale":
      return "The bridge restarted while this was active; verify the external session before continuing.";
    default:
      return "Keep this row updated until the issue is parked, ready, or archived.";
  }
}

function openClawRunNote(run) {
  const issue = run?.issueUrl || `#${run?.issueNumber || "?"}`;
  return [
    `OpenClaw work: #${run?.issueNumber || "?"} ${run?.title || ""}`.trim(),
    `Issue: ${issue}`,
    `Status: ${openClawRunLabel(run)}`,
    run?.queueId ? `Queue: ${run.queueId}` : "",
    run?.id ? `Run: ${run.id}` : "",
    run?.note ? `Note: ${run.note}` : "",
    `Next: ${openClawRunNextAction(run)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function openClawCommandPlan({ workflow, workflowError, queues, runner, preferences, governor }) {
  const runway = openClawWorkerRunway(queues, runner, preferences);
  const runs = Array.isArray(runner?.runs) ? runner.runs : [];
  const mission = openClawMissionControl(runs, runner);
  const candidate = runway.lanes.find((lane) => lane.candidate)?.candidate || null;
  const gates = openClawCommandGates({
    workflow,
    workflowError,
    queues,
    runner,
    runway,
    governor,
    candidate,
  });
  if (mission.focusRun) {
    const prUrl = openClawValidPrUrl(mission.focusRun.prUrl);
    return {
      runway,
      gates,
      run: mission.focusRun,
      candidate: null,
      tone: openClawRunTone(mission.focusRun) || "warn",
      headline: `#${mission.focusRun.issueNumber || "?"}: ${openClawMissionHeadline(mission.focusRun)}`,
      detail: openClawRunNextAction(mission.focusRun),
      subject: openClawMissionLabel(mission.focusRun),
      meta: [
        mission.focusRun.queueId || "",
        prUrl ? "PR linked" : "",
        `${mission.plateCount} ${mission.plateCount === 1 ? "plate" : "plates"}`,
      ].filter(Boolean),
    };
  }
  if (candidate) {
    const priority = openClawCandidatePriorityLabel(candidate);
    const bridgeReady = runner?.status === "connected";
    const newWorkReady = Boolean(governor?.canStartNewWork);
    const blockReason = !newWorkReady
      ? governor?.reasons?.[0] || "New work is paused by the current limits."
      : !bridgeReady
        ? "Connect the local Codex bridge before starting work."
        : "";
    const queueMeta = priority
      ? candidate.queueId?.startsWith("maintainer")
        ? candidate.queueId
        : ""
      : candidate.queueId || "";
    return {
      runway,
      gates,
      run: null,
      candidate,
      tone: bridgeReady && newWorkReady ? "ok" : "warn",
      headline: blockReason ? "New work is paused" : `#${candidate.number}: next eligible issue`,
      detail: blockReason || openClawCandidateWhy(candidate),
      subject: blockReason
        ? `Next held: #${candidate.number}`
        : priority
          ? `${priority} queue`
          : "queueable",
      meta: [
        priority && blockReason ? priority : queueMeta,
        candidate.author ? `@${candidate.author}` : "",
      ].filter(Boolean),
    };
  }
  const blocked = Boolean(workflowError || governor?.reasons?.length);
  return {
    runway,
    gates,
    run: null,
    candidate: null,
    tone: blocked ? "danger" : "warn",
    headline: blocked ? "New work is paused" : "No eligible issue loaded",
    detail:
      workflowError ||
      governor?.reasons?.[0] ||
      "Refresh the queue, lower the test age gate, or wait for ClawSweeper-screened work.",
    subject: blocked ? "blocked" : "idle",
    meta: [],
  };
}

function openClawCommandGates({
  workflow,
  workflowError,
  queues,
  runner,
  runway,
  governor,
  candidate,
}) {
  const queueErrors = (Array.isArray(queues) ? queues : []).filter((queue) => queue?.error).length;
  const prError = workflow?.pullRequests?.error;
  const usageKnown = governor?.usageDrop !== null && governor?.usageDrop !== undefined;
  const usageLabel = usageKnown ? `${governor.usageDrop}/${governor.usageLimit}` : "-";
  return [
    {
      label: "GitHub",
      value: workflowError ? "error" : queueErrors || prError ? "partial" : "ok",
      detail:
        workflowError || prError || (queueErrors ? `${queueErrors} queue errors` : "queues loaded"),
      tone: workflowError ? "danger" : queueErrors || prError ? "warn" : "ok",
    },
    {
      label: "Limits",
      value: governor?.canStartNewWork ? "open" : "paused",
      detail: governor?.reasons?.[0] || `usage ${usageLabel}`,
      tone: governor?.canStartNewWork ? "ok" : "warn",
    },
    {
      label: "Bridge",
      value: runner?.status === "connected" ? "connected" : runner?.status || "unknown",
      detail: runner?.info?.dryRun ? "dry-run" : runner?.error || "local Codex",
      tone: runner?.status === "connected" ? "ok" : runner?.status === "error" ? "danger" : "warn",
    },
    {
      label: "Lanes",
      value: `${runway.filled}/${runway.capacity}`,
      detail: `${runway.empty} ${runway.empty === 1 ? "open lane" : "open lanes"}`,
      tone: runway.empty ? "ok" : "warn",
    },
    {
      label: "Next",
      value: candidate ? `#${candidate.number}` : "none",
      detail: candidate
        ? openClawCandidatePriorityLabel(candidate) || candidate.queueId || "queueable"
        : "no candidate",
      tone: candidate ? "ok" : "warn",
    },
  ];
}

function openClawWorkerRunway(queues, runner, preferences) {
  const preferredCapacity = Math.max(
    1,
    Math.min(8, Number(preferences?.maxParallelWorkers || runner?.info?.maxActive || 1) || 1),
  );
  const bridgeMaxActive =
    runner?.status === "connected" ? Number(runner?.info?.maxActive || 0) || null : null;
  const runs = Array.isArray(runner?.runs) ? runner.runs : [];
  const plates = runs
    .filter((run) => run && !run.archivedAt && !openClawRunInactive(run))
    .sort((left, right) => openClawRunAttentionScore(left) - openClawRunAttentionScore(right));
  const capacity = Math.max(preferredCapacity, Math.min(8, plates.length), 1);
  const candidates = openClawRunwayCandidates(queues, runner, capacity);
  const lanes = [];
  let candidateIndex = 0;
  for (let index = 0; index < capacity; index += 1) {
    const run = plates[index];
    const candidate = run ? null : candidates[candidateIndex++] || null;
    lanes.push({
      id:
        run?.id ||
        (candidate ? openClawIssueKey(candidate.number, candidate.url) : `empty-${index}`),
      index: index + 1,
      kind: run ? "filled" : candidate ? "suggested" : "empty",
      run,
      candidate,
      title: run ? "Plate in flight" : candidate ? "Next best issue" : "Open lane",
      subtitle: run
        ? openClawMissionLabel(run)
        : candidate
          ? openClawCandidateLaneSubtitle(candidate)
          : "Waiting for an eligible candidate",
    });
  }
  const filled = plates.length;
  const empty = Math.max(0, capacity - filled);
  return {
    capacity,
    preferredCapacity,
    filled,
    empty,
    lanes,
    bridgeMaxActive,
    bridgeWarning:
      bridgeMaxActive && bridgeMaxActive < preferredCapacity
        ? `Local bridge can start ${bridgeMaxActive} Codex ${bridgeMaxActive === 1 ? "job" : "jobs"} right now. Restart it with the Runner command to use the ${preferredCapacity}-worker preference.`
        : "",
    summary: openClawRunwaySummary(filled, empty, preferredCapacity, capacity),
  };
}

function openClawRunwayCandidates(queues, runner, limit) {
  const bestByIssue = new Map();
  let order = 0;
  for (const queue of Array.isArray(queues) ? queues : []) {
    for (const candidate of Array.isArray(queue?.candidates) ? queue.candidates : []) {
      const withQueue = { ...candidate, queueId: candidate.queueId || queue.definition?.id || "" };
      const key = openClawIssueKey(withQueue.number, withQueue.url);
      if (!key) continue;
      if (openClawRunnerHasIssueRun(runner, withQueue.number, withQueue.url)) continue;
      if (!withQueue.signals?.readyForPickup) continue;
      const entry = {
        candidate: withQueue,
        score: openClawCandidatePriorityRank(withQueue, queue?.definition),
        order: order++,
      };
      const existing = bestByIssue.get(key);
      if (
        !existing ||
        entry.score < existing.score ||
        (entry.score === existing.score && entry.order < existing.order)
      ) {
        bestByIssue.set(key, entry);
      }
    }
  }
  return [...bestByIssue.values()]
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.candidate);
}

function openClawRunwaySummary(filled, empty, preferredCapacity, capacity) {
  if (filled > preferredCapacity) {
    return `${filled} plates are on deck, above the ${preferredCapacity}-worker preference. Finish, park, or hand off before adding more.`;
  }
  if (filled === 0 && empty > 0) {
    return `${empty} worker ${empty === 1 ? "lane is" : "lanes are"} open. Suggested issues are ordered by the OpenClaw queue rules.`;
  }
  if (empty > 0) {
    return `${filled} ${filled === 1 ? "plate is" : "plates are"} in flight and ${empty} ${empty === 1 ? "lane is" : "lanes are"} ready for the next issue.`;
  }
  return `All ${capacity} worker ${capacity === 1 ? "lane is" : "lanes are"} occupied. Focus on proof, PR readiness, CI, and ClawSweeper.`;
}

function openClawCandidateLaneSubtitle(candidate) {
  const priority = openClawCandidatePriorityLabel(candidate);
  const queueId = candidate?.queueId || "OpenClaw queue";
  return priority ? `${priority} - ${queueId}` : queueId;
}

function openClawCandidateWhy(candidate) {
  const bits = [];
  const priority = openClawCandidatePriorityLabel(candidate);
  if (priority === "P0") bits.push("P0 first");
  else if (priority === "P1") bits.push("P1 next");
  else if (priority === "P2") bits.push("P2 queue");
  if (candidate?.signals?.sourceRepro) bits.push("source repro");
  if (candidate?.signals?.fixShapeClear) bits.push("clear fix shape");
  if (candidate?.signals?.currentMainRepro) bits.push("current-main proof");
  if (candidate?.signals?.needsLiveValidation) bits.push("needs live proof");
  return bits.length
    ? bits.join(", ")
    : "ClawSweeper marked this issue queueable, open, and without a linked fix PR.";
}

function openClawWorkerRunwayBrief(runway, runner) {
  return [
    "OpenClaw worker lane plan",
    `Runner: ${runner?.status || "unknown"}${runner?.info?.dryRun ? " (dry-run)" : ""}`,
    `Lanes: ${runway.filled}/${runway.capacity} filled; ${runway.empty} open`,
    runway.summary,
    "",
    ...runway.lanes.map((lane) => {
      if (lane.run) {
        return [
          `Lane ${lane.index}: #${lane.run.issueNumber || "?"} [${openClawRunLabel(lane.run)}] ${lane.run.title || "OpenClaw issue"}`,
          lane.run.issueUrl ? `Issue: ${lane.run.issueUrl}` : "",
          `Next: ${openClawRunNextAction(lane.run)}`,
        ]
          .filter(Boolean)
          .join("\n");
      }
      if (lane.candidate) {
        const priority = openClawCandidatePriorityLabel(lane.candidate);
        return [
          `Lane ${lane.index}: suggested #${lane.candidate.number} ${lane.candidate.title}`,
          `Issue: ${lane.candidate.url}`,
          priority ? `Priority: ${priority}` : "",
          `Queue: ${lane.candidate.queueId}`,
          `Why: ${openClawCandidateWhy(lane.candidate)}`,
        ]
          .filter(Boolean)
          .join("\n");
      }
      return `Lane ${lane.index}: open, no eligible queue item loaded`;
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function openClawMissionControl(runs, runner) {
  const allRows = Array.isArray(runs) ? runs.filter((run) => run && !run.archivedAt) : [];
  const inactiveRows = allRows.filter((run) => openClawRunInactive(run));
  const inactiveCount = inactiveRows.length;
  const currentRows = allRows.filter((run) => !openClawRunInactive(run));
  const plates = currentRows.length ? currentRows : inactiveRows.length <= 10 ? inactiveRows : [];
  const sorted = [...plates].sort(
    (left, right) => openClawRunAttentionScore(left) - openClawRunAttentionScore(right),
  );
  const focusRun = sorted[0] || null;
  if (!focusRun) {
    return {
      focusRun: null,
      plateCount: 0,
      label: inactiveCount ? "cleanup" : "clear",
      tone: inactiveCount ? "warn" : "ok",
      headline: inactiveCount
        ? `${inactiveCount} inactive runner rows are in history`
        : "No OpenClaw plates are active",
      detail: inactiveCount
        ? "Archive inactive rows to clear old completed, stale, failed, or dry-run history before starting a new demo."
        : "Start or track a queue item when you are ready to pick up work.",
      items: [],
    };
  }
  const runnerMode = runner?.info?.dryRun ? "Dry-run bridge" : "Local bridge";
  return {
    focusRun,
    plateCount: plates.length,
    label: openClawMissionLabel(focusRun),
    tone: openClawRunTone(focusRun),
    headline: `#${focusRun.issueNumber || "?"}: ${openClawMissionHeadline(focusRun)}`,
    detail: `${runnerMode}. ${openClawRunNextAction(focusRun)}`,
    items: sorted.slice(0, 3).map((run, index) => ({
      run,
      rank: index + 1,
      label: openClawMissionLabel(run),
      tone: openClawRunTone(run),
    })),
  };
}

function openClawRunAttentionScore(run) {
  const statusOrder = {
    ready: 0,
    failed: 1,
    stale: 2,
    completed: 3,
    "dry-run": 4,
    parked: 5,
    tracked: 6,
    running: 7,
    starting: 8,
  };
  return (statusOrder[run?.status] ?? 20) * 100 + openClawRunQueueScore(run);
}

function openClawRunQueueScore(run) {
  const text = `${run?.queueId || ""} ${run?.title || ""}`.toLowerCase();
  if (text.includes("p0")) return 0;
  if (text.includes("p1")) return 10;
  if (text.includes("p2")) return 20;
  return 40;
}

function openClawMissionLabel(run) {
  switch (run?.status) {
    case "ready":
      return "handoff ready";
    case "failed":
      return "needs repair";
    case "stale":
      return "verify session";
    case "completed":
      return "check proof";
    case "dry-run":
      return "dry-run only";
    case "parked":
      return "blocked";
    case "tracked":
      return "manual plate";
    case "running":
    case "starting":
      return "Codex active";
    default:
      return "needs update";
  }
}

function openClawMissionHeadline(run) {
  switch (run?.status) {
    case "ready":
      return "copy the maintainer handoff";
    case "failed":
      return "repair the failed run or park it";
    case "stale":
      return "confirm whether the external Codex session is still alive";
    case "completed":
      return "turn the completed run into proof, PR state, and handoff";
    case "dry-run":
      return "restart the bridge live or paste the captured prompt";
    case "parked":
      return "blocked until the missing proof or decision lands";
    case "tracked":
      return "resume the manual Codex/tmux work";
    case "running":
    case "starting":
      return "watch the active Codex run";
    default:
      return "update this plate";
  }
}

function openClawRunChecklist(run) {
  const text = openClawRunKnownText(run);
  const ready = run?.status === "ready";
  const live = openClawRunActive(run);
  const proofKnown = ready || /\b(proof|tested|tests?|pnpm|mantis)\b/.test(text);
  const reviewKnown = ready || /codex review|review passed|review clean/.test(text);
  const prKnown = Boolean(openClawValidPrUrl(run?.prUrl));
  const ciKnown = ready || /\bci\b|clawsweeper|ready for maintainer/.test(text);
  return [
    { label: "Intake", done: true },
    { label: "Proof", done: proofKnown, tone: live ? "warn" : "" },
    { label: "Review", done: reviewKnown },
    { label: "PR", done: prKnown },
    { label: "CI/ClawSweeper", done: ciKnown },
  ];
}

function openClawReadinessRadar(runs) {
  const rows = Array.isArray(runs) ? runs.filter((run) => run && !run.archivedAt) : [];
  const total = rows.length;
  const countMissing = (label) =>
    rows.filter(
      (run) => !openClawRunChecklist(run).some((item) => item.label === label && item.done),
    ).length;
  const ready = rows.filter((run) => run?.status === "ready").length;
  const missingPr = countMissing("PR");
  const missingProof = countMissing("Proof");
  const missingReview = countMissing("Review");
  const missingCi = countMissing("CI/ClawSweeper");
  return [
    {
      label: "Ready",
      value: `${ready}/${total}`,
      detail: "handoff rows",
      tone: ready ? "ok" : "",
    },
    {
      label: "Needs PR",
      value: String(missingPr),
      detail: missingPr ? "link or open PR" : "all linked",
      tone: missingPr ? "warn" : "ok",
    },
    {
      label: "Needs proof",
      value: String(missingProof),
      detail: missingProof ? "tests or Mantis" : "proof noted",
      tone: missingProof ? "warn" : "ok",
    },
    {
      label: "Needs review",
      value: String(missingReview),
      detail: missingReview ? "Codex review" : "review noted",
      tone: missingReview ? "warn" : "ok",
    },
    {
      label: "CI/ClawSweeper",
      value: String(missingCi),
      detail: missingCi ? "still unknown" : "state noted",
      tone: missingCi ? "warn" : "ok",
    },
  ];
}

function openClawRunKnownText(run) {
  return [run?.status, run?.note, openClawValidPrUrl(run?.prUrl), run?.title, run?.queueId]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function openClawActiveWorkBrief(runs, runner) {
  const allRows = Array.isArray(runs) ? runs.filter((run) => run && !run.archivedAt) : [];
  const inactiveRows = allRows.filter((run) => openClawRunInactive(run));
  const currentRows = allRows.filter((run) => !openClawRunInactive(run));
  const plates = currentRows.length ? currentRows : inactiveRows.length <= 10 ? inactiveRows : [];
  const inactiveCount = inactiveRows.length;
  const mission = openClawMissionControl(plates, runner);
  const activeCount = plates.filter((run) => openClawRunActive(run)).length;
  const readyCount = plates.filter((run) => run?.status === "ready").length;
  const parkedCount = plates.filter((run) => run?.status === "parked").length;
  const radar = openClawReadinessRadar(plates);
  const closeoutLine = radar.length
    ? `Closeout: ${radar.map((item) => `${item.label} ${item.value}`).join("; ")}`
    : "";
  const maxActive = runner?.info?.maxActive || "-";
  return [
    "OpenClaw active work brief",
    `Runner: ${runner?.status || "unknown"}${runner?.info?.dryRun ? " (dry-run)" : ""}`,
    `Plates: ${plates.length}; active ${activeCount}/${maxActive}; ready ${readyCount}; parked ${parkedCount}; inactive history ${inactiveCount}`,
    closeoutLine,
    mission.focusRun
      ? `Focus: #${mission.focusRun.issueNumber || "?"} ${mission.focusRun.title || "OpenClaw issue"} - ${mission.label}`
      : "Focus: no active plates",
    "",
    ...plates
      .sort((left, right) => openClawRunAttentionScore(left) - openClawRunAttentionScore(right))
      .map(openClawRunBriefLines)
      .flat(),
  ]
    .filter((line, index, all) => line || all[index - 1])
    .join("\n");
}

function openClawRunBriefLines(run) {
  const prUrl = openClawValidPrUrl(run?.prUrl);
  return [
    `- #${run?.issueNumber || "?"} [${openClawRunLabel(run)}] ${run?.title || "OpenClaw issue"}`,
    run?.issueUrl ? `  Issue: ${run.issueUrl}` : "",
    prUrl ? `  PR: ${prUrl}` : "  PR: not linked in Claw Queue yet",
    `  Next: ${openClawRunNextAction(run)}`,
    run?.note ? `  Note: ${run.note}` : "",
    "",
  ].filter(Boolean);
}

function openClawRunResumePrompt(run) {
  const prUrl = openClawValidPrUrl(run?.prUrl);
  return [
    `Resume this OpenClaw work item from Claw Queue: ${run?.issueUrl || `#${run?.issueNumber || "?"}`}`,
    "",
    `Title: ${run?.title || "OpenClaw issue"}`,
    `Issue number: #${run?.issueNumber || "?"}`,
    run?.queueId ? `Queue: ${run.queueId}` : "",
    `Current Claw Queue status: ${openClawRunLabel(run)}`,
    prUrl ? `Known PR: ${prUrl}` : "Known PR: not linked in Claw Queue yet",
    run?.logPath ? `Runner log: ${run.logPath}` : "",
    run?.note ? `Current note: ${run.note}` : "",
    "",
    "Resume process:",
    "1. Re-check the issue and any linked/open PRs on GitHub before changing code.",
    "2. Read the latest local OpenClaw AGENTS.md, CONTRIBUTING.md, and pull request template before continuing.",
    "3. Continue from the smallest safe fix shape, following ClawSweeper's assessment and route.",
    "4. Add or refresh proof: reproduction, focused tests, before/after evidence, and Mantis only if available and relevant.",
    "5. Run the appropriate Codex review before opening or updating the PR, normally: codex review --base origin/main.",
    "6. Update or open the PR only when proof, tests, Codex review, and PR body are ready for maintainer review.",
    "7. Monitor CI and ClawSweeper after updates. Fix failures, explain non-actionable failures, or park if proof is insufficient and Mantis is unavailable.",
    "",
    "When finished, return a Discord-ready maintainer handoff with PR link, issue link, one-line summary, proof/tests, Codex review result, CI state, and ClawSweeper readiness.",
  ]
    .filter(Boolean)
    .join("\n");
}

function openClawRunHandoff(run) {
  const prUrl = openClawValidPrUrl(run?.prUrl);
  return [
    `Maintainer review requested: #${run?.issueNumber || "?"} ${run?.title || "OpenClaw issue"}`,
    prUrl ? `PR: ${prUrl}` : "PR: add PR link",
    run?.issueUrl ? `Issue: ${run.issueUrl}` : "",
    "Summary: Focused OpenClaw fix is ready for maintainer review.",
    "Proof: add local tests/proof and Mantis evidence if available.",
    `State: ${openClawRunLabel(run)}; codex review result needed; CI/ClawSweeper readiness needed.`,
    run?.note ? `Note: ${run.note}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function openClawValidPrUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    const parts = url.pathname.split("/").filter(Boolean);
    const pullNumber = Number(parts[3]);
    if (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com" &&
      parts.length === 4 &&
      parts[2] === "pull" &&
      Number.isInteger(pullNumber) &&
      pullNumber > 0
    ) {
      url.hash = "";
      url.search = "";
      return url.toString();
    }
  } catch {}
  return "";
}

function nullableFormNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function FleetPage(props) {
  const sessions = props.state.interactiveSessions || [];
  const fleet = props.state.fleet;
  const totals = fleet?.totals || {};
  const fleetSessionsById = new Map(
    (fleet?.sessions || []).map((session) => [session.id, session]),
  );
  const groups = groupedFleetSessions(sessions);
  const ownerCount = groups.length;
  const repos = props.state.repos?.length || 0;
  const sessionLabel = props.cli ? `${props.cli} attachable` : "none attached";
  return (
    <section class="dashboard" aria-label="Crabfleet dashboard">
      <div class="setup-stack">
        <DashboardAction
          icon="git-pull-request"
          title="GitHub access"
          text={`Repos, pull requests, and gh credentials are scoped to ${props.userLabel}.`}
          action={props.signedIn ? "Connected" : "Connect"}
          disabled={props.signedIn}
          onClick={props.beginLogin}
        />
        <div class="setup-card">
          <div>
            <h2>
              <Icon name="terminal" />
              Connect over SSH
            </h2>
            <p>Link a public key once, then create, list, attach, and open VNC for crabboxes.</p>
          </div>
          <CopyCommand value={`ssh link@${sshHost}`} />
        </div>
        <div class="setup-card">
          <div>
            <h2>
              <Icon name="square-terminal" />
              Start a Crabbox
            </h2>
            <p>Crabboxes boot with the repo prepared and Codex ready for OpenClaw supervision.</p>
          </div>
          <CopyCommand
            value={`ssh ${sshHost} new --repo openclaw/crabfleet "fix the failing check"`}
          />
        </div>
      </div>
      <div class="status-strip">
        <Metric label="Running" value={totals.active ?? activeFleetCount(sessions)} />
        <Metric label="People" value={ownerCount} />
        <Metric label="Crabboxes" value={totals.sessions ?? sessions.length} />
      </div>
      <FleetControlPanel fleet={fleet} repos={repos} />
      <div class="dashboard-grid">
        <DashboardChart
          title="OPENCLAW QUEUE"
          value={`${props.active}/${props.state.cap}`}
          meta={`${props.queue} queued`}
        />
        <DashboardChart
          title="CRABBOX FLEET"
          value={sessionLabel}
          meta={`${repos} repos`}
          secondary
        />
      </div>
      <section class="vm-list">
        <div class="section-kicker">ALL CRABBOXES BY PERSON</div>
        {groups.length ? (
          groups.map(([owner, items]) => (
            <section class="fleet-owner" key={owner}>
              <header class="fleet-owner-head">
                <strong>{sessionOwnerLabel(owner)}</strong>
                <span>{activeFleetCount(items)} active</span>
              </header>
              <div class="fleet-box-grid">
                {items.map((session) => (
                  <FleetBox
                    key={session.id}
                    session={{ ...session, fleet: fleetSessionsById.get(session.id) }}
                    openSessionGrid={props.openSessionGrid}
                  />
                ))}
              </div>
            </section>
          ))
        ) : (
          <div class="vm-row empty-row">
            <div>
              <strong>No crabboxes yet</strong>
              <code>ssh {sshHost} new --repo openclaw/crabfleet</code>
              <span>Create one from SSH, the Go CLI, or the app.</span>
            </div>
            <button
              onClick={() => props.openDrawer("interactive")}
              disabled={!canMaintain(props.state.user)}
            >
              New crabbox
            </button>
          </div>
        )}
      </section>
    </section>
  );
}

function FleetControlPanel({ fleet, repos }) {
  const totals = fleet?.totals || {};
  const egress = fleet?.egress || {};
  const registry = fleet?.registryAvailable === false ? "registry unavailable" : "registry online";
  return (
    <section class="fleet-control-panel" aria-label="Fleet control plane">
      <div>
        <div class="section-kicker">CONTROL PLANE</div>
        <h2>{fleet?.canonicalUrl || `https://${productDomain}`}</h2>
        <p>
          Tracks every visible Codex crabbox, its runtime, log archive, attach state, and redacted
          sandbox egress policy.
        </p>
      </div>
      <div class="fleet-control-grid">
        <Metric label="Ready" value={totals.ready ?? 0} />
        <Metric label="Provisioning" value={totals.provisioning ?? 0} />
        <Metric label="Archived" value={totals.archived ?? 0} />
        <Metric label="Policies" value={egress.sessionsWithPolicy ?? 0} />
      </div>
      <div class="fleet-control-meta">
        <span>{registry}</span>
        <span>{egress.defaultHostCount ?? 0} default egress hosts</span>
        <span>{repos} allowed repos</span>
        <a href="/docs/spec-v2">Spec v2</a>
      </div>
    </section>
  );
}

function FleetBox({ session, openSessionGrid }) {
  const capabilities = runCapabilities(session);
  const archiveCount = session.logArchive?.eventCount || session.logs?.length || 0;
  const fleetPolicy = session.fleet?.policy;
  return (
    <article class="fleet-box">
      <header class="fleet-box-head">
        <strong>{session.repo || session.title || session.id}</strong>
        <span class={`state-pill ${session.status || "pending"}`}>
          {session.status || "pending"}
        </span>
      </header>
      <div class="fleet-box-meta">
        <span>{session.branch || "main"}</span>
        <span>{session.runtime || "crabbox"}</span>
        {capabilities.vnc ? <span>webvnc</span> : null}
        {archiveCount ? <span>{archiveCount} logs</span> : null}
        {fleetPolicy?.present ? <span>{fleetPolicy.allowedHostCount} egress</span> : null}
      </div>
      <p class="fleet-box-event">{session.lastEvent || "Waiting for crabbox"}</p>
      <code>
        ssh {sshHost} attach {session.id}
      </code>
      <div class="fleet-box-actions">
        <button onClick={() => openSessionGrid(session.id)}>Terminal</button>
        {session.vncUrl ? (
          <button onClick={() => window.open(session.vncUrl, "_blank", "noopener")}>VNC</button>
        ) : capabilities.vnc ? (
          <button
            class="pending-vnc"
            disabled
            title="WebVNC URL appears after crabbox provisioning"
          >
            VNC pending
          </button>
        ) : null}
        {!session.sharedReadOnly ? (
          <button onClick={() => window.open(sessionLogsUrl(session.id), "_blank", "noopener")}>
            Logs
          </button>
        ) : null}
      </div>
    </article>
  );
}

function sessionLogsUrl(id) {
  return `/api/interactive-sessions/${encodeURIComponent(id)}/logs`;
}

function DashboardAction({ icon, title, text, action, disabled, onClick }) {
  return (
    <div class="setup-card">
      <div>
        <h2>
          <Icon name={icon} />
          {title}
        </h2>
        <p>{text}</p>
      </div>
      <button onClick={onClick} disabled={disabled}>
        {action}
      </button>
    </div>
  );
}

function DashboardChart({ title, value, meta, secondary }) {
  const path = secondary
    ? "M8 82 C 40 74, 52 76, 78 58 S 130 50, 158 42 S 214 32, 250 34"
    : "M8 84 C 28 72, 42 78, 58 64 S 92 62, 112 50 S 140 72, 158 46 S 210 38, 250 28";
  return (
    <article class="chart-card">
      <div class="chart-head">
        <span>{title}</span>
        <strong>{value}</strong>
      </div>
      <svg viewBox="0 0 260 96" role="img" aria-label={`${title} ${value}`}>
        <path class="chart-grid" d="M8 24 H252 M8 54 H252 M8 84 H252" />
        <path class="chart-line" d={path} />
      </svg>
      <div class="chart-foot">
        <span class="dot" />
        {meta}
      </div>
    </article>
  );
}

function DevIdentityPanel({ hidden, user, onDevIdentity }) {
  const currentId = user?.subject?.startsWith("dev:")
    ? user.subject.slice("dev:".length)
    : user?.login || "admin-1";
  const currentName = user?.name || user?.login || "Admin 1";
  const currentRole = user?.role || "owner";
  const [id, setId] = useState(currentId);
  const [name, setName] = useState(currentName);
  const [role, setRole] = useState(currentRole);

  useEffect(() => {
    if (hidden) return;
    setId(currentId);
    setName(currentName);
    setRole(currentRole);
  }, [hidden, currentId, currentName, currentRole]);

  async function submit(identity) {
    setId(identity.id);
    setName(identity.name);
    setRole(identity.role);
    await onDevIdentity(identity);
  }

  return (
    <div
      class="dev-identity-panel"
      hidden={hidden}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        void submit({ id, name, role });
      }}
    >
      <div class="dev-identity-title">Dev identity</div>
      <div class="dev-identity-presets">
        {devIdentityPresets.map((preset) => (
          <button type="button" onClick={() => void submit(preset)}>
            {preset.name}
          </button>
        ))}
      </div>
      <label>
        <LabelText
          text="ID"
          help="Preview-only fake login/subject. Apply switches the local preview identity."
        />
        <input value={id} onInput={(event) => setId(event.currentTarget.value)} />
      </label>
      <label>
        <LabelText text="Name" help="Preview-only display name for the local fake identity." />
        <input value={name} onInput={(event) => setName(event.currentTarget.value)} />
      </label>
      <label>
        <LabelText
          text="Role"
          help="Preview-only permission role. Apply can enable or disable controls in the mock app."
        />
        <select value={role} onInput={(event) => setRole(event.currentTarget.value)}>
          <option value="owner">Owner</option>
          <option value="maintainer">Maintainer</option>
          <option value="viewer">Viewer</option>
        </select>
      </label>
      <button class="primary" type="button" onClick={() => void submit({ id, name, role })}>
        Apply
      </button>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div class="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CopyCommand({ value }) {
  async function copy() {
    await copyText(value);
  }
  return (
    <button class="terminal-command" type="button" onClick={() => void copy()} title="Copy command">
      <code>{value}</code>
      <Icon name="copy" />
    </button>
  );
}

async function copyText(value) {
  if (!navigator.clipboard) return;
  await navigator.clipboard.writeText(String(value || ""));
}

function RefPreview({ preview, canCreate, onCreate }) {
  if (!preview.number) return <div class="ref-preview" hidden />;
  const title = preview.loading
    ? `Looking up #${preview.number}`
    : `Matches for #${preview.number}`;
  return (
    <div class="ref-preview">
      <div class="ref-preview-head">
        <span>{title}</span>
        <span>{preview.matches.length || ""}</span>
      </div>
      {preview.loading ? (
        <div class="ref-empty">Searching allowed OpenClaw repos...</div>
      ) : preview.error ? (
        <div class="ref-empty">{preview.error}</div>
      ) : preview.matches.length ? (
        <div class="ref-preview-list">
          {preview.matches.map((match, index) => (
            <div class="ref-row">
              <div>
                <div class="ref-title">{match.title}</div>
                <div class="ref-meta">
                  <span class="chip">
                    {match.repo}#{match.number}
                  </span>
                  <span class="chip merge">{match.source}</span>
                  <span class="chip">{match.state}</span>
                  {match.author ? <span class="chip">@{match.author}</span> : null}
                </div>
              </div>
              {canCreate ? (
                <button class="primary" onClick={() => onCreate(index)}>
                  New card
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div class="ref-empty">No issue or PR #{preview.number} in enabled repos.</div>
      )}
    </div>
  );
}

function Board(props) {
  const current = props.state.user?.login || props.state.user?.email || props.state.user?.subject;
  const query = props.search.trim().toLowerCase();
  const visibleCards = props.state.cards.filter((card) => {
    if (props.filter === "mine" && card.owner !== current) return false;
    if (props.filter === "hot" && card.lane !== "Running") return false;
    return matchesCard(card, query);
  });
  return (
    <section class="board" aria-label="Crabfleet board">
      {lanes.map((lane) => {
        const cards = visibleCards.filter((card) => card.lane === lane);
        return (
          <section class="lane" key={lane}>
            <div class="lane-head">
              <span>{lane}</span>
              <small>{cards.length}</small>
            </div>
            <div class="cards">
              {cards.length ? (
                cards.map((card) => <Card key={card.id} card={card} {...props} />)
              ) : (
                <div class="empty">No cards</div>
              )}
            </div>
          </section>
        );
      })}
    </section>
  );
}

function matchesCard(card, query) {
  if (!query) return true;
  const changedPaths = (card.changes?.files || []).map((file) => file.path).join(" ");
  return [card.id, card.title, card.repo, card.source, card.runtime, card.policy, changedPaths]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function Card({ card, state, cardAction, attachCard }) {
  const cls =
    card.lane === "Running"
      ? "running"
      : card.lane === "Human Review"
        ? "review"
        : card.lane === "Done"
          ? "done"
          : "";
  const maintain = canMaintain(state.user);
  return (
    <article class={`card ${cls}`}>
      <div>
        <h3>{card.title}</h3>
        <p>{card.prompt}</p>
      </div>
      <div class="meta">
        <span class="chip">{card.id}</span>
        <span class="chip">{card.repo}</span>
        <span class="chip">{card.runtime}</span>
        {card.run ? <span class="chip">{card.run.id}</span> : null}
        <span class="chip merge">{card.policy}</span>
        {card.lane === "Running" ? (
          <span class="chip hot">
            {card.run?.status || "live"} {elapsed(card.run?.lastHeartbeatAt || card.startedAt)}
          </span>
        ) : null}
      </div>
      <ChangeCard changes={card.changes} />
      <div class="card-actions">
        {maintain ? (
          <button onClick={() => cardAction(card.id, card.lane === "Running" ? "pulse" : "start")}>
            {card.lane === "Running" ? "Pulse" : "Start"}
          </button>
        ) : null}
        <button onClick={() => attachCard(card.id)}>Attach</button>
        {maintain ? <button onClick={() => cardAction(card.id, "advance")}>Move</button> : null}
      </div>
    </article>
  );
}

function ChangeCard({ changes }) {
  const value = changes || { files: [], totals: { additions: 0, deletions: 0 } };
  if (!value.files.length) return null;
  return (
    <div class="change-card" aria-label="Changed files">
      <div class="change-card-head">
        <span>Diff</span>
        <span>{value.files.length} files</span>
        <span class="change-delta">
          <span class="add">+{value.totals.additions}</span>{" "}
          <span class="del">-{value.totals.deletions}</span>
        </span>
      </div>
      {value.files.slice(0, 3).map((file) => (
        <div class="change-file">
          <span class={`status-badge ${file.status}`}>{statusLabel(file.status)}</span>
          <span class="change-path" title={file.path}>
            {file.path}
          </span>
          <span class="change-delta">
            <span class="add">+{Number(file.additions) || 0}</span>{" "}
            <span class="del">-{Number(file.deletions) || 0}</span>
          </span>
        </div>
      ))}
      {value.files.length > 3 ? <span>+{value.files.length - 3} more</span> : null}
    </div>
  );
}

function CardDrawer({ drawers, closeDrawer, createCard, state }) {
  const [busy, setBusy] = useState(false);
  return (
    <Drawer
      id="card-drawer"
      open={drawers.card}
      title="New card"
      onClose={() => closeDrawer("card")}
    >
      <form
        class="form-grid"
        aria-busy={busy ? "true" : "false"}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await createCard(event.currentTarget);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Source
          <select name="source">
            <option>Prompt</option>
            <option>Issue</option>
            <option>PR</option>
          </select>
        </label>
        <RepoSelect repos={state.repos} name="repo" />
        <label class="full">
          Title (optional)
          <input name="title" placeholder="Generated from prompt if blank" />
        </label>
        <label class="full">
          Prompt
          <textarea name="prompt" required placeholder="Describe the Codex task" />
        </label>
        <label>
          Runtime
          <select name="runtime">
            <option>auto</option>
            <option>container</option>
            <option>crabbox</option>
          </select>
        </label>
        <label>
          Merge policy
          <select name="policy">
            <option value="">repo default</option>
            <option>open_pr</option>
            <option>merge_when_green</option>
            <option>fix_until_green_and_merge</option>
          </select>
        </label>
        <div class="actions full">
          <button type="button" disabled={busy} onClick={() => closeDrawer("card")}>
            Cancel
          </button>
          <button class="primary" type="submit" disabled={busy}>
            {busy ? "Creating..." : "Create"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}

function InteractiveDrawer({ drawers, closeDrawer, createInteractiveSession, state }) {
  const [busy, setBusy] = useState(false);
  return (
    <Drawer
      id="interactive-drawer"
      open={drawers.interactive}
      title="New Crabbox"
      onClose={() => closeDrawer("interactive")}
    >
      <form
        class="form-grid"
        aria-busy={busy ? "true" : "false"}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await createInteractiveSession(event.currentTarget);
          } finally {
            setBusy(false);
          }
        }}
      >
        <RepoSelect repos={state.repos} name="repo" />
        <label>
          Branch
          <input name="branch" defaultValue="main" placeholder="main" />
        </label>
        <label>
          Runtime
          <select name="runtime">
            <option value="container">Cloudflare Sandbox</option>
            <option value="crabbox">Crabbox</option>
          </select>
        </label>
        <label>
          Command
          <input name="command" defaultValue="codex --yolo" placeholder="codex --yolo" />
        </label>
        <label class="full">
          Prompt (optional)
          <textarea name="prompt" placeholder="Initial note for the interactive box" />
        </label>
        <div class="actions full">
          <button type="button" disabled={busy} onClick={() => closeDrawer("interactive")}>
            Cancel
          </button>
          <button class="primary" type="submit" disabled={busy}>
            {busy ? "Provisioning..." : "Create crabbox"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}

function RepoSelect({ repos, name }) {
  const values = preferredRepos(repos);
  return (
    <label>
      Repo
      <select name={name} defaultValue={values.includes(preferredRepo) ? preferredRepo : values[0]}>
        {values.map((repo) => (
          <option>{repo}</option>
        ))}
      </select>
    </label>
  );
}

function RunDrawer({ drawers, closeDrawer, activeRunId, state, cardAction }) {
  const card = state.cards.find((item) => item.id === activeRunId);
  return (
    <Drawer
      id="run-drawer"
      open={drawers.run}
      title={card ? `${card.id} - ${card.title}` : "Run"}
      wide
      onClose={() => closeDrawer("run")}
    >
      <div class="run-layout">
        <div class="run-main">
          <pre class="terminal">{card?.logs?.join("\n") || ""}</pre>
          <DiffPanel card={card} />
        </div>
        <aside class="sidebox">
          {card ? <RunSide card={card} state={state} cardAction={cardAction} /> : null}
        </aside>
      </div>
    </Drawer>
  );
}

function DiffPanel({ card }) {
  const files = card?.changes?.files || [];
  const patch = card?.changes?.patch || "";
  if (!files.length) return <section class="diff-panel" hidden />;
  return (
    <section class="diff-panel">
      <div class="diff-head">
        <strong>Changed files</strong>
        <span>
          {files.length} files · +{card.changes.totals.additions} -{card.changes.totals.deletions}
        </span>
      </div>
      {files.map((file) => (
        <details key={file.path} open>
          <summary>
            <span>{file.path}</span>
            <span>
              +{file.additions} -{file.deletions}
            </span>
          </summary>
          {file.patch ? <pre>{file.patch}</pre> : null}
        </details>
      ))}
      <pre>{patch || "No patch preview"}</pre>
    </section>
  );
}

function RunSide({ card, state, cardAction }) {
  const capabilities = runCapabilities(card);
  const capabilityLabel = Object.entries(capabilities)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(", ");
  const maintain = canMaintain(state.user);
  return (
    <>
      <h3>Session</h3>
      <div class="kv">
        <span>
          Repo <strong>{card.repo}</strong>
        </span>
        <span>
          Runtime <strong>{card.run?.runtime || card.runtime}</strong>
        </span>
        <span>
          Run <strong>{card.run?.id || "none"}</strong>
        </span>
        <span>
          Merge <strong>{card.policy}</strong>
        </span>
        <span>
          Status <strong>{card.run?.status || card.lane}</strong>
        </span>
        <span>
          Capabilities <strong>{capabilityLabel || "none"}</strong>
        </span>
      </div>
      <h3>Capabilities</h3>
      <div class="kv">
        {Object.entries(capabilities).map(([key, value]) => (
          <span>
            {key} <strong>{value ? "yes" : "no"}</strong>
          </span>
        ))}
      </div>
      <button onClick={() => cardAction(card.id, "watch")}>Watch</button>
      {maintain && hasRunCapability(card, "takeover") ? (
        <button class="primary" onClick={() => cardAction(card.id, "takeover")}>
          Take over
        </button>
      ) : null}
      {maintain && isActiveRun(card) ? (
        <button onClick={() => cardAction(card.id, "stall")}>Mark stalled</button>
      ) : null}
    </>
  );
}

function SessionsDrawer(props) {
  const open = Boolean(props.drawers.sessions);
  const focusedCandidate = props.focusedSessionId
    ? props.sessionItemById.get(props.focusedSessionId)
    : null;
  const focused = focusedCandidate && isSessionGridItem(focusedCandidate) ? focusedCandidate : null;
  const gridItems = props.allSessionItems.filter(isSessionGridItem);
  const sessions = focused ? [focused] : orderedSessionItems(gridItems, props.sessionLayout);
  const singleSession = sessions.length === 1;
  useEffect(() => {
    if (!open) return;
    disposeMissingTerminals(new Set(sessions.map((session) => session.id)));
  }, [open, sessions.map((session) => session.id).join("\0")]);
  return (
    <div
      class={`drawer ${open ? "open" : ""}`}
      id="sessions-drawer"
      aria-hidden={open ? "false" : "true"}
    >
      <section class="panel session-panel">
        <div class="panel-head session-head">
          <div>
            <h2>Codex sessions</h2>
            <p>Live Codex CLI terminals with shareable read access.</p>
          </div>
          <SessionTools focused={Boolean(focused)} {...props} />
        </div>
        <div class="panel-body">
          <section
            class={`session-grid ${props.sessionLayout.columns !== "auto" && !focused ? "fixed-columns" : ""} ${
              props.sessionLayout.edit && !focused ? "layout-editing" : ""
            } ${focused ? "focus-mode" : ""} ${singleSession ? "single-session" : ""}`}
            style={{
              "--session-columns":
                props.sessionLayout.columns !== "auto" && !focused
                  ? props.sessionLayout.columns
                  : "1",
            }}
            aria-label="Codex session grid"
          >
            {sessions.length ? (
              sessions.map((session) => (
                <SessionCell
                  key={session.id}
                  session={session}
                  focused={Boolean(focused)}
                  singleSession={singleSession}
                  drawerOpen={open}
                  {...props}
                />
              ))
            ) : (
              <div class="session-empty">
                <button
                  class="primary session-empty-action"
                  disabled={!canMaintain(props.state.user)}
                  onClick={() => props.openDrawer("interactive")}
                >
                  New Codex session
                </button>
                <span>No Codex sessions yet</span>
              </div>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}

function SessionTools({
  focused,
  sessionLayout,
  setSessionLayout,
  closeDrawer,
  openDrawer,
  showSessionGrid,
  cleanupDeadInteractiveSessions,
  state,
}) {
  const deadCount = (state.interactiveSessions || []).filter((session) =>
    canCleanInteractiveSession(session, state.user),
  ).length;
  return (
    <div class="session-tools">
      <button
        class="primary"
        disabled={!canMaintain(state.user)}
        onClick={() => openDrawer("interactive")}
      >
        New session
      </button>
      <label class="session-columns-field">
        <span>Columns</span>
        <select
          value={focused ? "1" : sessionLayout.columns}
          disabled={focused}
          onChange={(event) =>
            setSessionLayout((layout) => ({ ...layout, columns: event.currentTarget.value }))
          }
        >
          {["auto", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].map((value) => (
            <option value={value}>{value === "auto" ? "Auto" : value}</option>
          ))}
        </select>
      </label>
      <details class="session-layout-menu">
        <summary>Layout</summary>
        <div class="session-layout-popover">
          <button
            disabled={focused}
            class={sessionLayout.edit && !focused ? "primary" : ""}
            onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              setSessionLayout((layout) => ({ ...layout, edit: !layout.edit }));
            }}
          >
            {sessionLayout.edit && !focused ? "Done editing" : "Edit layout"}
          </button>
          <button
            disabled={focused}
            onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              setSessionLayout(defaultSessionLayout(true));
            }}
          >
            Reset
          </button>
        </div>
      </details>
      <button onClick={showSessionGrid} hidden={!focused}>
        Grid
      </button>
      {deadCount ? (
        <button class="danger" onClick={cleanupDeadInteractiveSessions}>
          Clean dead ({deadCount})
        </button>
      ) : null}
      <button class="icon" aria-label="Close sessions" onClick={() => closeDrawer("sessions")}>
        <Icon name="x" />
      </button>
    </div>
  );
}

function SessionCell(props) {
  const session = props.session;
  const editable = props.sessionLayout.edit && !props.focused;
  const branchLabel =
    session.kind === "interactive"
      ? session.branch && session.branch !== "main"
        ? session.branch
        : ""
      : session.branch || session.policy || "";
  return (
    <article
      class={`session-cell ${editable ? "layout-editing" : ""}`}
      draggable={editable}
      data-session-cell={session.id}
      onDragStart={(event) => {
        if (!editable) return;
        props.draggedSessionId.current = session.id;
        event.currentTarget.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", session.id);
      }}
      onDragOver={(event) => {
        if (
          !props.draggedSessionId.current ||
          !editable ||
          props.draggedSessionId.current === session.id
        )
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        event.currentTarget.classList.add("drop-target");
      }}
      onDragLeave={(event) => event.currentTarget.classList.remove("drop-target")}
      onDrop={(event) => {
        const sourceId = props.draggedSessionId.current;
        event.currentTarget.classList.remove("drop-target");
        if (!sourceId || sourceId === session.id) return;
        event.preventDefault();
        props.draggedSessionId.current = null;
        props.setSessionLayout((layout) =>
          moveSessionLayoutItem(layout, props.allSessionItems, sourceId, session.id),
        );
      }}
      onDragEnd={(event) => {
        props.draggedSessionId.current = null;
        event.currentTarget.classList.remove("dragging", "drop-target");
      }}
    >
      <header class="session-cell-head">
        <div class="session-cell-title">
          <strong>{session.repo}</strong>
          {branchLabel ? <span>{branchLabel}</span> : null}
        </div>
        <SessionStatus session={session} />
        <div class="session-controls">
          {editable ? <SessionLayoutButtons session={session} {...props} /> : null}
          {!props.focused && !editable ? (
            <button
              onClick={() => {
                props.setFocusedSessionId(session.id);
                props.openSessionGrid(session.id, { deepLink: session.kind === "interactive" });
              }}
            >
              Maximize
            </button>
          ) : null}
          <SessionActions session={session} minimal={!props.focused && !editable} {...props} />
        </div>
      </header>
      <div class="session-terminal-wrap">
        <TerminalMount
          key={terminalMountKey(session)}
          session={session}
          focused={props.focused}
          singleSession={props.singleSession}
          drawerOpen={props.drawerOpen}
        />
      </div>
      <footer class="session-cell-foot">
        <span>{sessionFooterSummary(session)}</span>
        <span>{sessionTerminalStatusLabel(session, props.terminalStatus)}</span>
      </footer>
    </article>
  );
}

function terminalMountKey(session) {
  if (session.kind !== "interactive") return session.id;
  return [session.id, session.command, session.leaseId || ""].join(":");
}

function isLocalInteractiveSession(session) {
  return session?.kind === "interactive" && String(session.id).startsWith("LOCAL-");
}

function sessionTerminalStatusLabel(session, terminalStatus) {
  if (session.kind === "interactive" && isDeadInteractiveSession(session)) return "Log replay";
  return terminalStatus[session.id] || runtimeCapabilityLabel(session);
}

function SessionLayoutButtons() {
  return (
    <span class="session-edit-controls">
      <button class="session-drag layout-control" draggable="true" title="Drag to rearrange">
        Move
      </button>
    </span>
  );
}

function SessionActions(props) {
  const session = props.session;
  if (session.kind === "interactive") return <InteractiveSessionActions {...props} />;
  if (props.minimal) {
    return (
      <>
        <button onClick={() => props.openRunDetails(session.id)}>Details</button>
      </>
    );
  }
  return (
    <>
      <button onClick={() => props.openRunDetails(session.id)}>Details</button>
      <button onClick={() => props.cardAction(session.id, "watch")}>Watch</button>
      {canMaintain(props.state.user) && hasRunCapability(session, "takeover") ? (
        <button onClick={() => props.cardAction(session.id, "takeover")}>Take over</button>
      ) : null}
    </>
  );
}

function InteractiveSessionActions(props) {
  const session = props.session;
  if (String(session.id).startsWith("LOCAL-")) return null;
  const stopped = isDeadInteractiveSession(session);
  const canManage = session.canManage || canMaintain(props.state.user);
  const canChangeMultiplayer = Boolean(session.canChangeMultiplayer);
  const shareAction = session.shareMode === "link_read" ? "disable_share" : "share_link";
  const shareLabel = session.shareMode === "link_read" ? "Unshare" : "Share";
  const multiplayerAction = session.multiplayerMode ? "disable_multiplayer" : "enable_multiplayer";
  const multiplayerLabel = session.multiplayerMode ? "Solo input" : "Multiplayer";
  const multiplayerTooltip = session.multiplayerMode
    ? 'Multiplayer attribution is on. Submitted prompts are prepended with a <sender name=""/> tag for the model.'
    : 'Turn on multiplayer attribution. Submitted prompts will be prepended with a <sender name=""/> tag for the model.';
  const handleShare = () => {
    if (shareAction === "disable_share")
      return props.interactiveSessionAction(session.id, shareAction);
    return props.shareInteractiveSession(session.id);
  };
  if (props.minimal) {
    return (
      <>
        {session.vncUrl ? (
          <button onClick={() => window.open(session.vncUrl, "_blank", "noopener")}>VNC</button>
        ) : null}
        <button onClick={() => window.open(sessionLogsUrl(session.id), "_blank", "noopener")}>
          Logs
        </button>
        {canManage ? <button onClick={handleShare}>{shareLabel}</button> : null}
        {canChangeMultiplayer ? (
          <button
            aria-pressed={session.multiplayerMode}
            title={multiplayerTooltip}
            onClick={() => props.interactiveSessionAction(session.id, multiplayerAction)}
          >
            {multiplayerLabel}
          </button>
        ) : null}
        {canManage ? (
          <button
            class="danger"
            onClick={() =>
              stopped
                ? props.cleanupInteractiveSession(session.id)
                : props.closeInteractiveSession(session.id)
            }
          >
            {stopped ? "Clean up" : "Close"}
          </button>
        ) : null}
      </>
    );
  }
  return (
    <>
      {session.vncUrl ? (
        <button onClick={() => window.open(session.vncUrl, "_blank", "noopener")}>VNC</button>
      ) : null}
      {!session.sharedReadOnly ? (
        <button onClick={() => window.open(sessionLogsUrl(session.id), "_blank", "noopener")}>
          Logs
        </button>
      ) : null}
      {canManage ? <button onClick={handleShare}>{shareLabel}</button> : null}
      {canChangeMultiplayer ? (
        <button
          aria-pressed={session.multiplayerMode}
          title={multiplayerTooltip}
          onClick={() => props.interactiveSessionAction(session.id, multiplayerAction)}
        >
          {multiplayerLabel}
        </button>
      ) : null}
      {session.canRequestControl && !session.sharedReadOnly && !stopped ? (
        <button onClick={() => props.interactiveSessionAction(session.id, "request_control")}>
          {session.controlRequestedBy ? "Control requested" : "Request control"}
        </button>
      ) : null}
      {canManage && session.controlRequestedBy ? (
        <>
          <button
            class="primary"
            onClick={() => props.interactiveSessionAction(session.id, "approve_control")}
          >
            Allow
          </button>
          <button onClick={() => props.interactiveSessionAction(session.id, "deny_control")}>
            Deny
          </button>
        </>
      ) : null}
      {canManage && session.controller ? (
        <button onClick={() => props.interactiveSessionAction(session.id, "revoke_control")}>
          Revoke
        </button>
      ) : null}
      {canManage ? (
        <button
          class="danger"
          onClick={() =>
            stopped
              ? props.cleanupInteractiveSession(session.id)
              : props.closeInteractiveSession(session.id)
          }
        >
          {stopped ? "Clean up" : "Close"}
        </button>
      ) : null}
    </>
  );
}

function isDeadInteractiveSession(session) {
  return (
    session &&
    (session.kind === undefined || session.kind === "interactive") &&
    deadInteractiveStatuses.has(session.status)
  );
}

function canCleanInteractiveSession(session, user) {
  return isDeadInteractiveSession(session) && (session.canManage || canMaintain(user));
}

function isSessionGridItem(session) {
  if (session?.kind === "interactive") return true;
  return session?.kind === "card" && isActiveRun(session);
}

function SessionStatus({ session }) {
  const status = sessionStatus(session);
  return <span class={`session-status ${status.tone}`}>{status.label}</span>;
}

function sessionStatus(session) {
  if (session.kind === "interactive") {
    if (session.routePlaceholder && session.status === "loading") {
      return { label: "Loading", tone: "provisioning" };
    }
    if (session.routePlaceholder && session.status === "unavailable") {
      return { label: "Unavailable", tone: "failed" };
    }
    if (["failed"].includes(session.status)) return { label: "Failed", tone: "failed" };
    if (["stopped", "expired"].includes(session.status))
      return { label: "Stopped", tone: "stopped" };
    if (session.status === "provisioning" || session.status === "pending_adapter") {
      return { label: "Provisioning", tone: "provisioning" };
    }
    if (session.shareMode === "link_read" || session.sharedReadOnly) {
      return { label: "Shared", tone: "shared" };
    }
    if (session.multiplayerMode) {
      return { label: "Multiplayer", tone: "shared" };
    }
    if (["ready", "attached", "detached"].includes(session.status)) {
      return { label: "Live", tone: "live" };
    }
    return { label: humanStatus(session.status), tone: "" };
  }
  if (session.run?.status === "failed" || session.lane === "Human Review") {
    return { label: humanStatus(session.run?.status || session.lane), tone: "failed" };
  }
  if (session.lane === "Running") return { label: "Live", tone: "live" };
  if (session.lane === "Done") return { label: "Done", tone: "stopped" };
  return { label: session.lane || humanStatus(session.run?.status), tone: "" };
}

function sessionFooterSummary(session) {
  if (session.kind === "interactive") {
    const parts = [session.id];
    const seen = session.lastSeenAt || session.updatedAt;
    if (seen) parts.push(`seen ${elapsed(seen)}`);
    if (session.status) parts.push(humanStatus(session.status));
    if (session.shareMode === "link_read" || session.sharedReadOnly) parts.push("shared");
    if (session.multiplayerMode) parts.push("multiplayer");
    if (session.controller) parts.push(`control ${session.controller}`);
    if (session.controlRequestedBy) parts.push(`request ${session.controlRequestedBy}`);
    return parts.join(" · ");
  }
  const parts = [session.id];
  if (session.run?.lastHeartbeatAt || session.startedAt) {
    parts.push(`seen ${elapsed(session.run?.lastHeartbeatAt || session.startedAt)}`);
  }
  if (session.run?.status) parts.push(humanStatus(session.run.status));
  if (session.run?.runtime || session.runtime) parts.push(session.run?.runtime || session.runtime);
  return parts.join(" · ");
}

function humanStatus(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function TerminalMount({ session, focused, singleSession, drawerOpen }) {
  const ref = useRef(null);
  const hideTimer = useRef(null);
  const mountedSessionId = useRef(null);
  const [visible, setVisible] = useState(focused);
  const provisioning = isProvisioningInteractiveSession(session);
  const localSession = isLocalInteractiveSession(session);
  const endedSession = session.kind === "interactive" && isDeadInteractiveSession(session);

  useLayoutEffect(
    () => () => {
      if (mountedSessionId.current) disposeTerminal(mountedSessionId.current);
      mountedSessionId.current = null;
    },
    [],
  );

  useEffect(() => {
    const clearHideTimer = () => {
      if (!hideTimer.current) return;
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    };
    if (focused || singleSession) {
      clearHideTimer();
      setVisible(true);
      return;
    }
    if (!drawerOpen) {
      clearHideTimer();
      setVisible(false);
      return;
    }
    const mount = ref.current;
    if (!mount || !("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const root = mount.closest(".panel-body");
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          clearHideTimer();
          setVisible(true);
          return;
        }
        clearHideTimer();
        hideTimer.current = setTimeout(() => {
          hideTimer.current = null;
          setVisible(false);
        }, 900);
      },
      {
        root,
        rootMargin: "360px 0px",
        threshold: 0,
      },
    );
    observer.observe(mount);
    return () => {
      observer.disconnect();
      clearHideTimer();
    };
  }, [session.id, focused, singleSession, drawerOpen]);

  useLayoutEffect(() => {
    const mount = ref.current;
    if (!mount) return;
    const active = drawerOpen && visible && !localSession && !provisioning && !endedSession;
    if (mountedSessionId.current && mountedSessionId.current !== session.id) {
      disposeTerminal(mountedSessionId.current);
      mountedSessionId.current = null;
    }
    mount.dataset.sessionId = active ? session.id : "";
    if (!active) {
      if (mountedSessionId.current) {
        disposeTerminal(mountedSessionId.current);
        mountedSessionId.current = null;
      }
      mount.innerHTML = "";
      return;
    }
    mountedSessionId.current = session.id;
    void mountTerminal(session, mount, { focused });
  }, [session, focused, drawerOpen, visible, provisioning, localSession, endedSession]);

  const terminalActive = drawerOpen && visible && !localSession && !provisioning && !endedSession;

  return (
    <div class="ghostty-terminal" aria-label={`${session.id} terminal`}>
      <div
        ref={ref}
        class="terminal-surface"
        data-session-id={terminalActive ? session.id : ""}
        hidden={!terminalActive}
      />
      {provisioning ? (
        <TerminalProvisioning session={session} />
      ) : localSession ? (
        <TerminalLocalStatus session={session} />
      ) : endedSession ? (
        <TerminalEndedTranscript session={session} />
      ) : !visible ? (
        <div class="terminal-placeholder">Terminal paused offscreen</div>
      ) : null}
    </div>
  );
}

function TerminalEndedTranscript({ session }) {
  return (
    <pre class="terminal-fallback terminal-ended" aria-label={`${session.id} log replay`}>
      {terminalText(session)}
    </pre>
  );
}

function TerminalProvisioning({ session }) {
  return (
    <div class="terminal-provisioning">
      <span class="terminal-progress" aria-hidden="true" />
      <strong>{session.routePlaceholder ? "Loading Codex" : "Preparing Codex"}</strong>
      <span>{session.repo || "Codex session"}</span>
      <small>{terminalProvisioningDetail(session)}</small>
    </div>
  );
}

function TerminalLocalStatus({ session }) {
  return (
    <div class={`terminal-provisioning ${session.status === "failed" ? "failed" : ""}`}>
      <span class="terminal-progress" aria-hidden="true" />
      <strong>{humanStatus(session.status || "Pending")}</strong>
      <span>{session.repo || "Codex session"}</span>
      <small>{session.lastEvent || session.logs?.at?.(-1) || "Waiting for session id"}</small>
    </div>
  );
}

function terminalProvisioningDetail(session) {
  if (session.status === "pending_adapter") return "Runtime adapter pending";
  if (isLocalInteractiveSession(session)) return session.lastEvent || "Requesting workspace";
  if (session.routePlaceholder) return "Opening shared session";
  return "Provisioning sandbox and terminal";
}

function AdminDrawer(props) {
  const owner = props.state.user?.role === "owner";
  return (
    <Drawer
      id="admin-drawer"
      open={props.drawers.admin}
      title="Admin"
      wide
      onClose={() => props.closeDrawer("admin")}
    >
      <div class="admin-grid">
        <AdminList
          title="Users and teams"
          placeholder="@login or @org/team"
          disabled={!owner}
          select={{
            values: [
              ["maintainer", "Maintainer"],
              ["owner", "Owner"],
              ["viewer", "Viewer"],
            ],
          }}
          rows={props.state.allow.map((item) => ({
            label: `${item.value} - ${item.role}`,
            value: item.value,
          }))}
          onAdd={(value, role) => props.addAllow(value, role)}
          onRemove={props.removeAllow}
        />
        <AdminList
          title="Repos"
          placeholder="owner/repo"
          disabled={!owner}
          rows={props.state.repos.map((repo) => ({ label: repo, value: repo }))}
          onAdd={props.addRepo}
          onRemove={props.removeRepo}
        />
        <PolicyBox disabled={!owner} state={props.state} updatePolicy={props.updatePolicy} />
        <WorkflowBox
          disabled={!owner}
          workflows={props.state.workflows || []}
          refreshWorkflow={props.refreshWorkflow}
        />
      </div>
    </Drawer>
  );
}

function AdminList({ title, placeholder, disabled, select, rows, onAdd, onRemove }) {
  const [value, setValue] = useState("");
  const [role, setRole] = useState(select?.values?.[0]?.[0] || "");
  return (
    <section class="admin-box">
      <h3>{title}</h3>
      <div class="form-grid">
        <input
          class="full"
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
        {select ? (
          <select
            class="full"
            value={role}
            disabled={disabled}
            onChange={(event) => setRole(event.currentTarget.value)}
          >
            {select.values.map(([key, label]) => (
              <option value={key}>{label}</option>
            ))}
          </select>
        ) : null}
        <button
          class="primary full"
          disabled={disabled}
          onClick={() => {
            if (!value.trim()) return;
            void onAdd(value.trim(), role);
            setValue("");
          }}
        >
          Add
        </button>
      </div>
      <div class="list">
        {rows.map((row) => (
          <div class="list-row">
            <span>{row.label}</span>
            <button
              class="icon"
              disabled={disabled}
              aria-label={`Remove ${row.label}`}
              onClick={() => onRemove(row.value)}
            >
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function PolicyBox({ disabled, state, updatePolicy }) {
  const [cap, setCap] = useState(state.cap);
  const [merge, setMerge] = useState(state.merge);
  const [retention, setRetention] = useState(state.retention);
  useEffect(() => {
    setCap(state.cap);
    setMerge(state.merge);
    setRetention(state.retention);
  }, [state.cap, state.merge, state.retention]);
  return (
    <section class="admin-box">
      <h3>Policy</h3>
      <label>
        Concurrent cap
        <input
          type="number"
          min="1"
          max="200"
          value={cap}
          disabled={disabled}
          onInput={(event) => setCap(event.currentTarget.value)}
        />
      </label>
      <label>
        Direct merge
        <select
          value={merge}
          disabled={disabled}
          onChange={(event) => setMerge(event.currentTarget.value)}
        >
          <option value="guarded">Guarded</option>
          <option value="disabled">Disabled</option>
          <option value="maintainers">Maintainers only</option>
        </select>
      </label>
      <label>
        Log retention
        <select
          value={retention}
          disabled={disabled}
          onChange={(event) => setRetention(event.currentTarget.value)}
        >
          <option value="30">30 days</option>
          <option value="14">14 days</option>
          <option value="60">60 days</option>
        </select>
      </label>
      <button
        class="primary"
        disabled={disabled}
        onClick={() => {
          const rawCap = Number(cap);
          updatePolicy({
            cap: Number.isFinite(rawCap) ? Math.min(200, Math.max(1, rawCap)) : 20,
            retention,
            merge,
          });
        }}
      >
        Save policy
      </button>
      <div class="kv">
        <span>
          Secrets: <strong>per org, referenced only</strong>
        </span>
        <span>
          VNC: <strong>Crabbox leases only</strong>
        </span>
      </div>
    </section>
  );
}

function WorkflowBox({ disabled, workflows, refreshWorkflow }) {
  const [repo, setRepo] = useState(preferredRepo);
  return (
    <section class="admin-box">
      <h3>Workflows</h3>
      <div class="form-grid">
        <input
          class="full"
          placeholder={preferredRepo}
          value={repo}
          disabled={disabled}
          onInput={(event) => setRepo(event.currentTarget.value)}
        />
        <button
          class="primary full"
          disabled={disabled}
          onClick={() => refreshWorkflow(repo.trim())}
        >
          Refresh CRABBOX.md
        </button>
      </div>
      <div class="list">
        {workflows.length ? (
          workflows.map((workflow) => {
            const config = workflow.config || {};
            const detail = [
              config.runtime ? `runtime=${config.runtime}` : "",
              config.policy ? `policy=${config.policy}` : "",
              workflow.error || "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div class="list-row">
                <span>
                  {workflow.repo} - {workflow.status}
                  {detail ? (
                    <>
                      <br />
                      <small>{detail}</small>
                    </>
                  ) : null}
                </span>
              </div>
            );
          })
        ) : (
          <div class="empty">No workflow evaluations</div>
        )}
      </div>
    </section>
  );
}

function Drawer({ id, open, title, wide, onClose, children }) {
  return (
    <div class={`drawer ${open ? "open" : ""}`} id={id} aria-hidden={open ? "false" : "true"}>
      <section class={`panel ${wide ? "wide" : ""}`}>
        <div class="panel-head">
          <h2>{title}</h2>
          <button class="icon" aria-label={`Close ${title}`} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div class="panel-body">{children}</div>
      </section>
    </div>
  );
}

function Icon({ name }) {
  const nodes = globalThis.lucideIconNodes?.[name];
  if (!nodes) return null;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {nodes.map(([tag, attrs], index) => {
        const Tag = tag;
        return <Tag key={`${tag}-${index}`} {...attrs} />;
      })}
    </svg>
  );
}

function orderedSessionItems(items, layout) {
  const currentIds = new Set(items.map((item) => item.id));
  if (!layout.manualOrder) return items;
  const order = [
    ...layout.order.filter((id) => currentIds.has(id)),
    ...items.map((item) => item.id).filter((id) => !layout.order.includes(id)),
  ];
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...items].sort(
    (left, right) =>
      (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

function moveSessionLayoutItem(layout, items, sourceId, targetId) {
  const ids = orderedSessionItems(items, layout).map((item) => item.id);
  const sourceIndex = ids.indexOf(sourceId);
  const targetIndex = ids.indexOf(targetId);
  if (sourceIndex === -1 || targetIndex === -1) return layout;
  ids.splice(sourceIndex, 1);
  ids.splice(targetIndex, 0, sourceId);
  return { ...layout, manualOrder: true, order: ids };
}

function defaultSessionLayout(edit = false) {
  return { columns: "auto", edit, manualOrder: false, order: [], sizes: {} };
}

function loadSessionLayout() {
  try {
    return normalizeSessionLayout(
      JSON.parse(localStorage.getItem(sessionLayoutStorageKey) || "null") || defaultSessionLayout(),
    );
  } catch {
    return defaultSessionLayout();
  }
}

function saveSessionLayout(layout) {
  try {
    localStorage.setItem(
      sessionLayoutStorageKey,
      JSON.stringify({
        columns: layout.columns,
        manualOrder: layout.manualOrder,
        order: layout.order,
        sizes: layout.sizes,
      }),
    );
  } catch {}
}

function normalizeSessionLayout(value) {
  return {
    columns: ["auto", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].includes(
      String(value?.columns),
    )
      ? String(value.columns)
      : "auto",
    edit: false,
    manualOrder: Boolean(value?.manualOrder),
    order: Array.isArray(value?.order) ? value.order.map(String).slice(0, 200) : [],
    sizes: typeof value?.sizes === "object" && value.sizes ? value.sizes : {},
  };
}

function parseSessionLink() {
  const match = location.pathname.match(/^\/(?:app\/)?sessions(?:\/([^/]+))?\/?$/);
  return {
    route: Boolean(match),
    id: match?.[1] ? decodeURIComponent(match[1]) : null,
    token: new URLSearchParams(location.search).get("token"),
  };
}

function initialAppView() {
  if (location.pathname === "/app/board" || location.pathname === "/app/board/") return "board";
  if (
    location.pathname === clawQueuePath ||
    location.pathname === `${clawQueuePath}/` ||
    location.pathname === "/app/openclaw" ||
    location.pathname === "/app/openclaw/"
  ) {
    return "openclaw";
  }
  return "fleet";
}

function isGithubLoginCallback() {
  return new URLSearchParams(location.search).get("login") === "github";
}

function restoreSessionReturnUrl() {
  try {
    const saved = sessionStorage.getItem(loginReturnKey);
    if (!saved || !history.replaceState) return;
    const url = new URL(saved, location.origin);
    const isSessionUrl =
      url.pathname === "/sessions" ||
      url.pathname === "/sessions/" ||
      url.pathname.startsWith("/sessions/") ||
      url.pathname.startsWith("/app/sessions/");
    if (url.origin !== location.origin || !isSessionUrl) return;
    if (location.pathname !== "/app" && location.pathname !== "/app/") return;
    sessionStorage.removeItem(loginReturnKey);
    history.replaceState(null, "", `${url.pathname}${url.search}`);
  } catch {}
}

function isTerminalKeyTarget(event) {
  const active = document.activeElement;
  return Boolean(
    event.target?.closest?.(".ghostty-terminal") || active?.closest?.(".ghostty-terminal"),
  );
}

render(
  <App />,
  document.getElementById("crabfleet-preact-root") ||
    document.getElementById("crabbox-preact-root"),
);
