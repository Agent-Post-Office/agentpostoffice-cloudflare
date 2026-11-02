-- Additive reply marker. Existing rows stay NULL; this migration does not backfill.
-- replied_at is the ISO timestamp of the latest messages:reply send Cloudflare accepted.
-- last_reply_message_id is that outbound message's id. No foreign key: deleting the
-- reply must keep working, and the marker remains after that row is gone.
ALTER TABLE messages ADD COLUMN replied_at TEXT;
ALTER TABLE messages ADD COLUMN last_reply_message_id TEXT;
