-- Per-inbox naive Bayes counts. Additive. Does not read or rewrite messages.
-- message_spam_training is one row per marked message. A repeated mark is a
-- no-op. A flip moves the token and class counts once.

CREATE TABLE inbox_spam_class_counts (
  inbox_id TEXT PRIMARY KEY REFERENCES inboxes(id),
  spam_messages INTEGER NOT NULL DEFAULT 0 CHECK (spam_messages >= 0),
  ham_messages INTEGER NOT NULL DEFAULT 0 CHECK (ham_messages >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE inbox_spam_token_counts (
  inbox_id TEXT NOT NULL REFERENCES inboxes(id),
  token TEXT NOT NULL,
  spam_count INTEGER NOT NULL DEFAULT 0 CHECK (spam_count >= 0),
  ham_count INTEGER NOT NULL DEFAULT 0 CHECK (ham_count >= 0),
  PRIMARY KEY (inbox_id, token)
);

CREATE INDEX IF NOT EXISTS inbox_spam_token_counts_inbox_idx ON inbox_spam_token_counts (inbox_id);

CREATE TABLE message_spam_training (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  inbox_id TEXT NOT NULL REFERENCES inboxes(id),
  label TEXT NOT NULL CHECK (label IN ('spam', 'ham')),
  tokens_json TEXT NOT NULL,
  trained_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS message_spam_training_inbox_idx ON message_spam_training (inbox_id, label);
