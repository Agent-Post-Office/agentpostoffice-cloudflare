-- Additive spam folder. Existing rows stay in inbox; this migration does not backfill scores.
-- folder is independent of archived_at. spam is not an archive marker.
-- Nothing in this migration deletes, rejects, or rewrites message content.
ALTER TABLE messages ADD COLUMN folder TEXT NOT NULL DEFAULT 'inbox' CHECK (folder IN ('inbox', 'spam'));
ALTER TABLE messages ADD COLUMN spam_score INTEGER;
ALTER TABLE messages ADD COLUMN spam_reasons_json TEXT;
ALTER TABLE messages ADD COLUMN spam_verdict TEXT CHECK (spam_verdict IS NULL OR spam_verdict IN ('spam', 'ham'));

-- NULL mode or threshold inherits the deployment SPAM_FILTER / SPAM_THRESHOLD vars.
CREATE TABLE inbox_spam_settings (
  inbox_id TEXT PRIMARY KEY REFERENCES inboxes(id),
  mode TEXT CHECK (mode IS NULL OR mode IN ('off', 'tag', 'quarantine')),
  threshold INTEGER CHECK (threshold IS NULL OR (threshold >= 0 AND threshold <= 100)),
  updated_at TEXT NOT NULL
);

-- Learned sender and domain lists. value is a normalized address or domain.
CREATE TABLE inbox_spam_rules (
  inbox_id TEXT NOT NULL REFERENCES inboxes(id),
  kind TEXT NOT NULL CHECK (kind IN ('allow_sender', 'block_sender', 'allow_domain', 'block_domain')),
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (inbox_id, kind, value)
);

CREATE INDEX IF NOT EXISTS inbox_spam_rules_inbox_idx ON inbox_spam_rules (inbox_id, kind);
