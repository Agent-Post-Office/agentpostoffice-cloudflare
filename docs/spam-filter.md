# Spam filter

Inbound mail is scored while it is parsed. The score is additive, from 0 to 100. A score greater than or equal to the threshold is spam. With the default threshold, 59 is ham and 60 is spam.

The scorer is the npm package `@agent-post-office/spam-filter`, pinned exactly in `packages/worker/package.json` (currently `0.1.1`). The source of truth is https://github.com/Agent-Post-Office/agent-post-office-spam-filter. Rules, weights, tokenization, and Bayes live there. The Worker keeps the D1 schema, marks, block and allow lists, and backfill, and calls the package to score and to compute training deltas. To change scoring, change it in that repository, release a new version (tag push; see its `RELEASING.md`), then bump the exact pin here.

Mail the filter flags in `tag` or `quarantine` mode does not enter the Sieve automation queue. A later automation task also returns before sending when the message is in the spam folder or carries the `spam` label. `off` stores the score and leaves that queue unchanged.

If scoring throws, parsing fails open: the message stays stored, the score columns stay empty, and Sieve still runs. A Bayes or training-table failure keeps the rules score. The filter does not call `setReject`, does not tombstone the message, and does not delete the raw MIME. Deleting mail is a separate `messages:delete` action.

`Authentication-Results` is stored from new deliveries onward and is the only authentication input. A passing result adds no points. A missing or unreadable header adds no points. When one mechanism has several results, `pass` and `bestguesspass` win over `fail`, and `fail` wins over `softfail`. `neutral`, `none`, `temperror`, and `permerror` add no points.

## Instance and inbox

Four Worker variables apply to the whole instance. Two columns in `inbox_spam_settings`, plus rows in `inbox_spam_rules`, apply to one inbox. Bayes counts are stored per inbox. The learning switch is still the instance variable.

| Setting | Scope | Where it lives | When it is unset |
| --- | --- | --- | --- |
| `SPAM_FILTER` | Instance | Worker var | `tag` |
| `SPAM_THRESHOLD` | Instance, unless the inbox row sets `threshold` | Worker var | `60` |
| `SPAM_LEARN` | Instance | Worker var | off |
| `SPAM_LEARN_MIN` | Instance | Worker var | `20` |
| `mode` | Inbox | `inbox_spam_settings.mode` | Inherits `SPAM_FILTER` |
| `threshold` | Inbox | `inbox_spam_settings.threshold` | Inherits `SPAM_THRESHOLD` |
| Block and allow rules | Inbox | `inbox_spam_rules` | No rules |
| Bayes counts | Inbox data | `inbox_spam_class_counts`, `inbox_spam_token_counts`, `message_spam_training` | Empty until a mark or a backfill |

Those four are the only spam Worker variables. `SPAM_LEARN` and `SPAM_LEARN_MIN` have no per-inbox column. One deployment uses the same learning switch for every inbox.

`npm run config:generate` writes the four variables into the ignored `packages/worker/wrangler.jsonc`. `packages/worker/wrangler.jsonc.example` uses the same values. Edit that file, then deploy, for an instance-wide change. A per-inbox row is read from D1 on the next scored message.

Resolution order for mode and threshold is the inbox column, then the Worker var, then the default. A null column inherits. A value the parser rejects also inherits: mode must be `off`, `tag`, or `quarantine` (trimmed, lower case); threshold must be an integer from 0 to 100.

```sql
INSERT INTO inbox_spam_settings (inbox_id, mode, threshold, updated_at)
VALUES ('inb_example', 'quarantine', 60, '2026-11-06T00:00:00.000Z')
ON CONFLICT(inbox_id) DO UPDATE SET
  mode = excluded.mode,
  threshold = excluded.threshold,
  updated_at = excluded.updated_at;
```

Set a column back to NULL to inherit the instance value again. There is no REST route for this table. Migration `0007_message_spam.sql` creates it.

## Modes

`SPAM_FILTER` is the instance mode. The code default is the constant `tag`.

| Mode | Folder when the verdict is spam | Labels when the verdict is spam | Sieve |
| --- | --- | --- | --- |
| `off` | `inbox` | Unchanged. The `spam` label is not added. | Still runs |
| `tag` | `inbox` | Adds `spam` | Skipped for that message |
| `quarantine` | `spam` | Adds `spam` | Skipped for that message |

A ham verdict in `tag` or `quarantine` leaves the folder at `inbox` and removes the `spam` label. `off` copies the labels it was given.

The label string is `spam`. Adding it keeps at most 19 other labels.

Operator marks do not follow this table. `mark-spam` always sets the folder to `spam` and adds the label. `mark-not-spam` always sets the folder to `inbox` and removes the label. That is true while the instance mode is `tag` or `off`.

## Threshold

The default 60 is the constant `DEFAULT_SPAM_THRESHOLD` in `@agent-post-office/spam-filter`. It is used when the Worker var and the inbox column are both unset or invalid.

`SPAM_THRESHOLD` is configurable. It is a Worker var, a string integer from 0 to 100. `inbox_spam_settings.threshold` overrides it for one inbox. The verdict is spam when `score >= threshold`.

## Signals

Authentication weights:

| Reason | Points |
| --- | --- |
| `auth_dmarc_fail` | 40 |
| `auth_spf_fail` | 20 |
| `auth_dkim_fail` | 20 |
| `auth_spf_softfail` | 10 |

Content weights. Each one is at most 19, so one content signal plus a DMARC failure stays at 59. There is no separate cap on the sum of content rules. Several rules add together, and the total score is then capped at 100.

| Reason | Points | Counts when |
| --- | --- | --- |
| `cold_audit` | 19 | Subject contains "we tested your". |
| `meeting_ask` | 16 | Subject or text asks for minutes or to book, schedule, or jump on a call or demo. |
| `verification_subject` | 16 | Subject asks to verify or confirm an email or account, or says "account verification" or "email address verification". |
| `outreach_opener` | 14 | Subject or text contains "we noticed", "I noticed", "came across", "saw that", "saw your", or "checking in". |
| `marketing_subdomain` | 12 | A pitch rule matched, and the sender domain's first label is `click`, `em`, `ems`, `mailer`, `marketing`, `mg`, `mkt`, `news`, or `send`. Skipped when that domain is `MAIL_DOMAIN` or a subdomain of it. |
| `unrelated_incident` | 12 | A pitch rule matched, the subject mentions downtime, an outage, or "is down", and the subject names a host that is not the sender domain, not a subdomain of it, and not a parent of it. |
| `empty_verification_body` | 10 | The verification subject matched and the text body is empty. |
| `urgency_notice` | 8 | The verification subject matched and the subject contains "important notice". |
| `freemail_verification` | 8 | The verification subject matched and the sender domain is in the freemail set below. |

`cold_audit`, `outreach_opener`, and `meeting_ask` are the pitch rules. `marketing_subdomain` and `unrelated_incident` count only beside a pitch. The three verification extras count only beside `verification_subject`.

Bayes is one more signal. Its own cap is 52. See [Bayes](#bayes).

## Block and allow lists

Rules live in `inbox_spam_rules`. The kinds are `block_sender`, `allow_sender`, `block_domain`, and `allow_domain`. They are per inbox. The value is the normalized envelope sender, or that sender's domain. The mark body does not take an address of its own.

Checked in this order, and the first match decides the verdict. Later signals, including Bayes, are not added.

| Kind | Score | Verdict |
| --- | --- | --- |
| `block_sender` | 100 | spam |
| `allow_sender` | 0 | ham |
| `block_domain` | 100 | spam |
| `allow_domain` | 0 | ham |

A sender on both the allow list and the block list is spam (`block_sender`). An exact sender allow beats a domain block. An exact sender block beats a domain allow. Domain rules match case-insensitively and include subdomains, so `example.com` matches `person@example.com` and `person@sub.example.com`.

Set them through the mark endpoints, the same flags on the CLI, or the same arguments on the MCP tools. Those calls need `messages:update` and `inboxes:manage`. If `inboxes:manage` is missing, the response is HTTP 403 and the message stays where it was.

`also_block_sender` on mark-spam deletes an `allow_sender` row for that envelope sender and inserts `block_sender`. `also_allow_sender` on mark-not-spam does the reverse. Domain flags do the same for `block_domain` and `allow_domain`. A repeated flag does not insert a second row.

A mark with no list flag leaves existing rules in place. There is no request that deletes a rule and writes nothing in its place. Delete the row:

```sql
DELETE FROM inbox_spam_rules
WHERE inbox_id = 'inb_example'
  AND kind = 'block_sender'
  AND value = 'person@example.com';
```

Do not block a freemail domain. `block_domain` scores every sender at that domain, and at its subdomains, as 100. The freemail set used by `freemail_verification` is `aol.com`, `gmail.com`, `gmx.com`, `gmx.net`, `googlemail.com`, `hotmail.com`, `icloud.com`, `live.com`, `mail.ru`, `me.com`, `msn.com`, `outlook.com`, `pm.me`, `proton.me`, `protonmail.com`, `yahoo.co.uk`, `yahoo.com`, `ya.ru`, `yandex.com`, and `yandex.ru`. Blocking your own mail domain has the same effect on every sender at that domain.

## Folders

`folder` is `inbox` or `spam`, separate from archive and from processed state.

List and poll take `inbox`, `spam`, or `all`. The default is `inbox`, so the spam folder stays out until the caller asks for it. `all` returns both.

| Surface | How |
| --- | --- |
| REST | `GET /v1/messages?folder=inbox`, `folder=spam`, or `folder=all`. Scope `messages:read`. |
| CLI | `messages list --folder inbox`, `--folder spam`, or `--folder all`. Omitting `--folder` uses inbox. |
| MCP | `poll_messages` with `folder` set to `inbox`, `spam`, or `all`. Any MCP client. The Worker serves the tool at `POST /mcp`, and the local stdio server serves it too. Scope `messages:read`. |

`GET /v1/messages/{id}` and the MCP tool `get_message` still return a spam-folder message, including `folder` and `spam` (`verdict`, `score`, `reasons`). Explicit `folder=inbox` or `folder=spam` returns HTTP 503 `migration_pending` with `folder requires migration 0007` until that migration is applied. The default feed still returns mail before `0007`, treating a missing `folder` column as inbox.

## Marking spam and not spam

Both routes need `messages:update`. They set the folder and the `spam` label as described under Modes. They set `spam_verdict` to `spam` or `ham` and append `operator_mark` to the stored reasons. They leave `spam_score` and processed state unchanged. Repeating the same mark returns the same state.

```bash
curl -sS -X POST https://agentpostoffice.example.workers.dev/v1/messages/msg_example/mark-spam \
  -H "Authorization: Bearer $AGENTPOSTOFFICE_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"also_block_sender":true}'
```

```bash
curl -sS -X POST https://agentpostoffice.example.workers.dev/v1/messages/msg_example/mark-not-spam \
  -H "Authorization: Bearer $AGENTPOSTOFFICE_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"also_allow_sender":true}'
```

REST fields are `also_block_sender` and `also_block_domain` on mark-spam, and `also_allow_sender` and `also_allow_domain` on mark-not-spam. Each one also needs `inboxes:manage`.

CLI, after `npm run build`:

```bash
node packages/cli/dist/index.js messages spam msg_example --block-sender
node packages/cli/dist/index.js messages spam msg_example --block-domain
node packages/cli/dist/index.js messages not-spam msg_example --allow-sender
node packages/cli/dist/index.js messages not-spam msg_example --allow-domain
```

`--block-sender` and `--block-domain` belong on `messages spam`. `--allow-sender` and `--allow-domain` belong on `messages not-spam`. The list flags need `inboxes:manage` as well as `messages:update`.

MCP tools, for any MCP client: `mark_spam` and `mark_not_spam`. Arguments are `message_id` plus the same `also_block_sender`, `also_block_domain`, `also_allow_sender`, and `also_allow_domain` booleans. Scope `messages:update`, and `inboxes:manage` when a list argument is true.

Marks and folder filters need migration `0007`. Until it is applied they return HTTP 503 `migration_pending`.

## Bayes

`SPAM_LEARN` is instance-wide. `on`, `true`, and `1` enable it (trimmed, lower case). Unset, empty, `off`, `0`, `false`, and any other value leave it off. The code default is off, and `packages/worker/wrangler.jsonc.example` keeps `"SPAM_LEARN": "off"`.

While it is off, scoring matches the rules score, and mark routes do not change token counts. A backfill can still record counts. Scoring ignores those counts until `SPAM_LEARN` is `on`.

While it is on, each operator mark stores one training row for that message. Marking it again in the same class does not add the tokens a second time. Flipping spam to not-spam, or back, moves the counts once. The model reads the subject (first 500 characters), the decoded text body (first 4,000 characters), the sender domain, and URL hosts. Counts stay inside the inbox that received the mark.

The signal stays quiet until that inbox has `SPAM_LEARN_MIN` marks in each class. The default is the constant 20. The Worker var accepts an integer from 1 to 100000. Anything else uses 20. This minimum is instance-wide. The counts it is compared with are per inbox.

After both classes reach that minimum, a spam posterior adds one signal when the formula below rounds to at least 1:

```text
round(52 * (p - 0.90) / 0.10)
```

The result is capped at 52. A posterior below 0.90 adds nothing. A posterior of exactly 0.90 rounds to 0, so it also adds nothing. A posterior of 0.91 is 5 points, reason `bayes_spam_0.91`. A posterior of 0.97 is 36 points, reason `bayes_spam_0.97`. A posterior of 1.00 is 52 points, reason `bayes_spam_1.00`.

52 is the default threshold minus the smallest other positive weight (8). Bayes alone stays ham at the default threshold. Bayes plus any one other content or authentication signal reaches 60. A ham posterior adds nothing, so learning cannot hide a rules hit. An allow or block decision is final before Bayes is considered.

`GET /v1/inboxes/{inbox_id}/spam-training` needs `messages:update` and returns `spam_messages`, `ham_messages`, `tokens`, `min_marks`, `learning`, and `ready`. `ready` is true when learning is on and both classes have at least `min_marks` marks. The route does not change mail. The CLI is `messages training --inbox <inbox-id>`. The MCP tool is `get_spam_training`. Until migration `0008` is applied, the route returns HTTP 503 `migration_pending` with `spam training requires migration 0008`.

## Backfill

`POST /v1/inboxes/{inbox_id}/spam-training` trains marks that already exist, including marks made while `SPAM_LEARN` was off. It needs `messages:update`. It counts only operator marks: the reasons include `operator_mark`, and the row is either verdict `spam` in the spam folder or verdict `ham` in the inbox. Auto-scored mail is left out.

Each call trains one page. `limit` defaults to 25 and must be an integer from 1 to 100, so a page trains at most 100 messages. The response is counts, not the messages. Repeat with `cursor` set to `next_cursor` until `done` is true. A message already in `message_spam_training` with the same label and tokens is unchanged, so a second run does not count it again. A mark flipped before the backfill counts once, in its final class. An unreadable raw message is skipped and counted in `skipped`, and the rest of the page still trains.

The response fields are `inbox_id`, `trained`, `unchanged`, `skipped`, `done`, and `next_cursor`.

```bash
curl -sS -X POST https://agentpostoffice.example.workers.dev/v1/inboxes/inb_example/spam-training \
  -H "Authorization: Bearer $AGENTPOSTOFFICE_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"limit":25}'
```

CLI, one page per run:

```bash
node packages/cli/dist/index.js messages training-backfill --inbox inb_example
node packages/cli/dist/index.js messages training-backfill --inbox inb_example --cursor <next_cursor>
```

`--limit` sets the page size. The MCP tool is `backfill_spam_training`, with `inbox_id` and optional `limit` and `cursor`, for any MCP client. Scope `messages:update`.

The first inbound message after `SPAM_LEARN` is on also runs one page of 25 when that inbox has no training rows and no class-count row. That pass does not continue through later pages. Use the command above to finish a larger inbox.

## How to test

Use a mailbox on `example.com` and an obviously fake sender. This check compares the stored `spam.reasons` with the weights above. It does not require a list rule.

A message from `person@example.com` with subject `We tested your checkout`, text `We noticed a problem. Got 15 minutes?`, and an `Authentication-Results` header of `dmarc=fail` (with SPF and DKIM passing) scores 89 and is spam at the default threshold:

- `auth_dmarc_fail` 40
- `cold_audit` 19
- `outreach_opener` 14
- `meeting_ask` 16

The same message with `dmarc=pass` scores 49 and is ham. The same subject with text `A short note.` and only `dmarc=fail` scores 59 and is ham. Subject `Hello` and text `A short note.` with `dmarc=fail` and `spf=fail` scores 60 and is spam. `dmarc=fail` alone on that message scores 40 and is ham.

After the message is stored:

```bash
node packages/cli/dist/index.js messages list --folder inbox
node packages/cli/dist/index.js messages get msg_example
node packages/cli/dist/index.js messages list --folder spam
node packages/cli/dist/index.js messages spam msg_example
node packages/cli/dist/index.js messages not-spam msg_example
```

`messages spam` moves that message to the spam folder. In `tag` mode the automatic score would have left it in the inbox with the `spam` label, so `--folder inbox` would still list it and `--folder spam` would not. `messages not-spam` moves it back and clears the label. Passing `--allow-sender` also writes an allow rule for `person@example.com` and needs `inboxes:manage`.
