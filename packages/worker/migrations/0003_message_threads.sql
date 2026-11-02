-- Additive thread links. Existing rows stay NULL; this migration does not backfill.
-- parent_message_id is the nearest stored ancestor in the same inbox.
-- thread_id is that ancestor's thread, or the ancestor's id when the ancestor
-- predates this column. A message with no stored ancestor is its own root.
-- No foreign key: deleting a parent must keep working, and thread_id has to
-- remain after the root row is gone. Indexes wait for a thread-list query;
-- parent resolution looks up RFC Message-IDs, not these columns.
ALTER TABLE messages ADD COLUMN parent_message_id TEXT;
ALTER TABLE messages ADD COLUMN thread_id TEXT;
