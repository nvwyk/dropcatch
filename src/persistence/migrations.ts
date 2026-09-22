/** Append-only. Each entry runs once, tracked by PRAGMA user_version. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE targets (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    expected_drop_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE target_state (
    target_id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    state TEXT NOT NULL,
    detail TEXT,
    updated_at TEXT NOT NULL,
    reset_at TEXT
  );

  CREATE TABLE watch_runs (
    id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL,
    mode TEXT NOT NULL,
    dry_run INTEGER NOT NULL,
    detected_at TEXT
  );
  CREATE INDEX idx_runs_target ON watch_runs (target_id, started_at);

  CREATE TABLE availability_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watch_run_id TEXT,
    provider TEXT NOT NULL,
    domain TEXT NOT NULL,
    status TEXT NOT NULL,
    registrable INTEGER,
    premium INTEGER,
    price_amount REAL,
    price_currency TEXT,
    latency_ms INTEGER NOT NULL,
    started_at TEXT,
    checked_at TEXT NOT NULL,
    error_code TEXT,
    reason TEXT,
    phase TEXT
  );
  CREATE INDEX idx_checks_run ON availability_checks (watch_run_id);
  CREATE INDEX idx_checks_provider ON availability_checks (provider, checked_at);

  CREATE TABLE registration_attempts (
    id TEXT PRIMARY KEY,
    watch_run_id TEXT,
    target_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    domain TEXT NOT NULL,
    status TEXT NOT NULL,
    dry_run INTEGER NOT NULL,
    price_amount REAL,
    price_currency TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    provider_reference TEXT,
    error_code TEXT,
    reason TEXT,
    availability_json TEXT,
    gate_json TEXT
  );
  CREATE INDEX idx_attempts_target ON registration_attempts (target_id, started_at);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT,
    watch_run_id TEXT,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    payload_json TEXT
  );
  CREATE INDEX idx_events_target ON events (target_id, id);
  `,
  `
  CREATE TABLE dashboard_auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE dashboard_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX idx_checks_domain ON availability_checks (domain, id);
  `,
];
