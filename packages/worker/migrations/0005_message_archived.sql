-- Additive archive marker. Existing rows stay NULL; this migration does not backfill.
-- archived_at is the ISO timestamp set by messages:update when archived is true.
-- NULL means the message is not archived. Independent of agent_state and replied_at.
ALTER TABLE messages ADD COLUMN archived_at TEXT;
