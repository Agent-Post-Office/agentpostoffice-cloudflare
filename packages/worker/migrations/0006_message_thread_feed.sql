-- 0003 deferred a thread index until a thread-list query existed.
-- GET /v1/messages?thread_id= excludes tombstones and orders by received_at, id.
-- thread_id leads so that listing is a range on this index. Queries do not name
-- the index, so the feed still succeeds after 0005 when this migration is pending.
CREATE INDEX messages_thread_feed_idx ON messages (thread_id, tombstoned_at, received_at, id);
