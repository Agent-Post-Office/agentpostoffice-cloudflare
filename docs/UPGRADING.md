# Upgrade existing deployments

Merging to this repository runs CI; it does not deploy self-hosted Workers. Use one ignored Wrangler configuration per existing instance and deploy serially with explicit operator approval.

Keep an ignored local registry (for example `.agentpostoffice/deployments.json`) with each instance’s alias, config path, Worker name, mail domain, Worker URL, database name, and verified deployed commit/version. Store no credentials or mail data in it.

Before upgrading, compare the deployed version and runtime with the proposed release. Preserve existing API routes, supported token scopes, queue task kinds, schema, scripts, and bindings. An unmerged feature branch may already be running in production; do not replace it with a main tree that lacks those features.

Run `npm ci`, `npm test`, `npm run check`, and `npm run build` before deployment. Confirm the canonical OpenAPI includes every route and regenerate its JSON artifact when it changes. Inspect migrations and declare the release's schema mode: none, additive expansion, or destructive contraction. A Worker rollback does not roll back the database.

`POST /mcp` is part of this Worker. Upgrading it does not add a D1 migration. The shared MCP tool-result cap is 1048576 bytes. It applies to the local stdio server and to `POST /mcp`. A larger result is `output_too_large` and does not include the payload.

The thread filter and archive marker are an additive expansion. `0005_message_archived.sql` adds nullable `messages.archived_at` and does not backfill. `0006_message_thread_feed.sql` adds `messages_thread_feed_idx` on `(thread_id, tombstoned_at, received_at, id)` and does not change rows. Apply `0005` before relying on archive reads or writes. Deploying this Worker after `0005` is the supported order: list, thread, and archive routes return their normal status codes, including when `0006` is still pending, because queries do not name the index. Deploying the Worker before `0005` leaves the default feed, `thread_id` filter, and processed-state updates working; those statements do not read `archived_at` (`thread_id` already exists from `0003`). `archived=true|false` and a PATCH body that sets `archived` then fail with HTTP 503 `migration_pending` until `0005` is applied. Rolling the Worker back does not remove the column.

`0007_message_spam.sql` is another additive expansion. Apply it after `0006`. It adds `messages.folder` (existing rows default to `inbox`), `spam_score`, `spam_reasons_json`, and `spam_verdict`, plus `inbox_spam_settings` and `inbox_spam_rules`. It does not backfill scores: those columns stay null, and subject, body, and labels are not rewritten. It also adds `messages_open_inbox_feed_idx` and `messages_open_spam_feed_idx`, partial indexes for the live inbox and spam feeds. Thread listings keep using `messages_thread_feed_idx`.

Deploy the Worker after `0007` is the supported order. The default feed still returns mail if this migration is pending, because a missing `folder` column is treated as inbox. Explicit `folder=inbox` or `folder=spam`, and `mark-spam` / `mark-not-spam`, return HTTP 503 `migration_pending` with `folder requires migration 0007` until it is applied. Archive behavior is unchanged. After `0007`, quarantine hides flagged mail from the default feed and from `messages list` unless `--folder spam` or `--folder all` is set. `tag` and `quarantine` do not run Sieve for mail they flag. `off` still stores the score and still runs Sieve.

Rolling the Worker back to the pre-spam release does not remove the new columns or tables. That release inserts and updates messages by column name and reads fields by name, so the added columns are ignored. Inserts that omit `folder` receive `inbox` from the column default. Leaving `0007` in place is the safe rollback.

Reverting the schema is a separate, destructive step and is not a down migration in this repository. Deploy the older Worker first, then drop only the spam objects. This discards folder placement and scores. It does not delete message rows.

```sql
DROP INDEX IF EXISTS messages_open_inbox_feed_idx;
DROP INDEX IF EXISTS messages_open_spam_feed_idx;
DROP INDEX IF EXISTS inbox_spam_rules_inbox_idx;
DROP TABLE IF EXISTS inbox_spam_rules;
DROP TABLE IF EXISTS inbox_spam_settings;
ALTER TABLE messages DROP COLUMN spam_verdict;
ALTER TABLE messages DROP COLUMN spam_reasons_json;
ALTER TABLE messages DROP COLUMN spam_score;
ALTER TABLE messages DROP COLUMN folder;
DELETE FROM d1_migrations WHERE name = '0007_message_spam.sql';
```

If `DROP COLUMN` is rejected, stop and leave the columns. The older Worker already tolerates them. Do not delete rows from `messages` to undo this migration.

`0008_spam_learn.sql` is an additive expansion. Apply it after `0007`. It adds `inbox_spam_class_counts`, `inbox_spam_token_counts`, and `message_spam_training`. It does not alter `messages` or backfill scores. The migration itself does not copy existing marks.

Apply 0007, then 0008, then deploy, then backfill. Set `SPAM_LEARN` to `on` in that instance when it should learn. The code default and `packages/worker/wrangler.jsonc.example` stay `off` for other self-hosters. After the Worker is deployed, backfill each inbox that already has mark-spam or mark-not-spam marks, including marks made while `SPAM_LEARN` was off:

```bash
node packages/cli/dist/index.js messages training-backfill --inbox <inbox-id>
```

Repeat with `--cursor <next_cursor>` until `done` is true. Each call trains one page (default 25, maximum 100) and needs `messages:update`. `POST /v1/inboxes/{inbox_id}/spam-training` and the MCP tool `backfill_spam_training` do the same page. A message already in `message_spam_training` is unchanged. A mark flipped before the backfill counts once, in its final class. An unreadable raw message is skipped and counted. The first inbound message after `SPAM_LEARN` is on also runs one page when that inbox has no training rows and no class-count row. That lazy pass does not continue through later pages. Use the command to finish a larger inbox.

With `SPAM_LEARN` unset or `off`, inbound scoring stays on the rules filter and mark routes do not write these tables. The backfill can still record counts; scoring ignores them until `SPAM_LEARN` is on. `GET` and `POST /v1/inboxes/{inbox_id}/spam-training` return HTTP 503 `migration_pending` with `spam training requires migration 0008` until this migration is applied. Those routes need `messages:update`. Marks, folder filters, and rules scoring keep working from `0007` alone. Turning `SPAM_LEARN` on before `0008` keeps the rules score: a missing count table fails open and does not drop mail.

Deploy the Worker after `0008` when the operator wants learned scoring, then run the backfill. Leaving `SPAM_LEARN` off after the migration is safe. Rolling the Worker back to the pre-learn release does not remove the new tables. That release never reads them, so leaving `0008` in place is the safe rollback. It does not change message rows.

Reverting the schema is a separate, destructive step and is not a down migration in this repository. Deploy the older Worker first, then drop only the learn objects. This discards trained counts. It does not delete message rows.

```sql
DROP INDEX IF EXISTS message_spam_training_inbox_idx;
DROP INDEX IF EXISTS inbox_spam_token_counts_inbox_idx;
DROP TABLE IF EXISTS message_spam_training;
DROP TABLE IF EXISTS inbox_spam_token_counts;
DROP TABLE IF EXISTS inbox_spam_class_counts;
DELETE FROM d1_migrations WHERE name = '0008_spam_learn.sql';
```

Do not delete rows from `messages` to undo this migration.

For each selected instance:

1. Verify the existing Wrangler account, Worker name, domain, deployment version, and named configuration.
2. Compare live D1/R2/Email bindings, variables, compatibility settings, queue producers and consumers with that configuration. Reuse the existing resources. Record the prior version for rollback.
3. Inspect applied migrations and existing schema. Skip migration application when the deployed schema already matches the release. Do not activate or modify scripts during an upgrade.
4. Run `wrangler deploy --dry-run --config <instance-config>`, inspect the compiled bindings, then deploy the reviewed release with the same config and a message containing its exact Git commit.
5. Verify the deployed version, public discovery/spec/health, protected authentication, and read-only inbox/Sieve access with that domain's existing credential kept in memory. Compare script revision/hash/activation metadata and queue settings with the baseline.
6. Continue to the next instance only after verification passes. Stop on a material mismatch. Revert to the recorded prior Worker version if necessary, preserving database and queue resources.

Upgrade checks do not authorize sending mail, activating new automation, deleting data, changing keys, or provisioning resources. Existing configured automation continues to operate normally.
