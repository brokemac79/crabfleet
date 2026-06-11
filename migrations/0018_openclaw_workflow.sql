CREATE TABLE IF NOT EXISTS openclaw_workflow_preferences (
  subject TEXT PRIMARY KEY,
  role_mode TEXT NOT NULL DEFAULT 'trial_maintainer',
  target_repo TEXT NOT NULL DEFAULT 'openclaw/openclaw',
  github_login TEXT,
  active_open_pr_limit INTEGER NOT NULL DEFAULT 10,
  hard_open_pr_cap INTEGER NOT NULL DEFAULT 20,
  daily_usage_drop_limit INTEGER NOT NULL DEFAULT 5,
  max_parallel_workers INTEGER NOT NULL DEFAULT 2,
  weekly_remaining_baseline INTEGER,
  weekly_remaining_current INTEGER,
  usage_window_started_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (subject) REFERENCES users(subject)
);
