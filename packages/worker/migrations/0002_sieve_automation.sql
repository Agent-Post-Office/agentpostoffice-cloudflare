PRAGMA foreign_keys = ON;

CREATE TABLE sieve_scripts (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL,
  source TEXT NOT NULL,
  compiled_ir_json TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (inbox_id, revision)
);

CREATE UNIQUE INDEX sieve_scripts_one_active_idx ON sieve_scripts (inbox_id) WHERE active = 1;

CREATE TABLE sieve_runs (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  script_id TEXT NOT NULL REFERENCES sieve_scripts(id) ON DELETE CASCADE,
  script_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('claimed', 'sent', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (message_id, script_id, script_revision)
);

CREATE TABLE sieve_vacation_responses (
  inbox_id TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  handle TEXT NOT NULL,
  sender_address TEXT NOT NULL,
  last_sent_at TEXT NOT NULL,
  PRIMARY KEY (inbox_id, handle, sender_address)
);
