# Agent Post Office: Cloudflare-native email for agents

Status: the local Phase 1 monorepo implementation is complete and covered by unit plus workerd integration tests. A Worker deployment exists under the earlier technical identifier, but mandatory live Cloudflare Phase 0 proof has not completed; the system is not production-validated.

Product name: **Agent Post Office**. Do not ship under **AgentMail**, which is the existing product and brand used as a reference.

## 1. Product goal

Agent Post Office is an open-source, self-hosted email service for agents. It runs in the operator's Cloudflare account, uses the operator's custom mail domain, and has no Agent Post Office-hosted control plane.

The first integration is pull-only:

1. Email arrives through Cloudflare Email Routing.
2. Agent Post Office stores and parses it.
3. An agent polls the API on a schedule.
4. The agent explicitly marks the message processed after handling it.

"Pull-only" means client-initiated REST requests instead of webhooks. It does not mean receive-only. The MVP receives mail, polls across multiple mailboxes, sends new transactional mail, and replies.

The product is for mailbox communication and support-style workflows. Bulk campaigns, mailing lists, and cold outreach are explicitly out of scope.

## 2. Agreed MVP boundary

| Decision | MVP choice |
| --- | --- |
| Deployment trust boundary | One trusted operator and one mail domain per deployment. |
| Mailboxes | Multiple logical addresses on that domain. |
| Primary consumer | One logical agent consumer; overlapping runs may process a message more than once. |
| Authentication | One domain-wide full-permission token by default; optional additional domain-wide scoped tokens. |
| Token administration | Direct documented D1 SQL through local Wrangler; no token-management REST, CLI, or MCP operation. |
| Agent surfaces | REST API, local CLI, and MCP tools over the same API. No web UI. |
| Polling | One unified domain feed with optional mailbox filtering. |
| Poll body | Up to 8 KiB of normalized plain text plus `body_truncated`. |
| Inbound size | 10 MiB raw-message default. |
| Retention | Indefinite until explicit deletion. |
| Delivery guarantee | Never acknowledge inbound SMTP until R2, D1, and Queue enqueue all succeed. |
| Outbound guarantee | `accepted` by Cloudflare, not guaranteed inbox delivery. |
| Cloudflare plan | Workers Paid with successful arbitrary-recipient Email Sending required. |

There is no receive-only free mode in the MVP.

## 3. Cloudflare services

| Capability | MVP status | Purpose |
| --- | --- | --- |
| Cloudflare DNS zone | Required | Hosts the selected apex domain or mail subdomain. |
| Email Routing | Required | Accepts inbound SMTP and invokes the Email Worker. |
| Worker | Required | Implements `email()`, `fetch()`, and `queue()`. |
| D1 | Required | Stores mailboxes, API-token hashes and scopes, message indexes, state, idempotency records, and attachment metadata. |
| R2 | Required | Stores raw MIME, complete parsed bodies, and attachments. |
| Queues plus DLQ | Required | Parses MIME and performs asynchronous deletion work with retries. Queue payloads contain IDs and R2 keys, never raw email. |
| Email Sending binding | Required | Sends new transactional mail and replies. |
| Worker observability | Required operationally | Surfaces ingestion, parsing, Queue, deletion, and outbound failures without application-level content logging. |

Not required for the MVP: Worker secrets for Agent Post Office authentication, KV, Durable Objects, Workflows, Cron Triggers, Workers AI, Vectorize, a dashboard, WebSockets, webhooks, WAF integration, application-level quotas, or usage reporting.

The Cloudflare deployment token is an external infrastructure credential. It is used locally during setup and D1 administration; it is never stored in the Worker and is unrelated to Agent Post Office bearer tokens.

## 4. Domain and routing model

`MAIL_DOMAIN` is a full operator-selected domain such as:

```text
example.com
mail.example.com
agents.example.com
```

The product must not hard-code a subdomain label. A dedicated subdomain remains the safest choice when another provider already receives mail for the apex, but apex-domain installation is supported.

The installation configures one Cloudflare catch-all routing rule for `MAIL_DOMAIN` that sends mail to the Worker. This is a transport scaling mechanism, not a catch-all mailbox:

- The Worker routes using the normalized SMTP envelope recipient, never the display `To` header.
- Only active mailbox rows in D1 receive mail.
- Unknown and disabled recipients are rejected at SMTP time.
- Unknown addresses never auto-create mailboxes and never fall back to another mailbox.

Creating or disabling a mailbox changes D1 state; it does not create a Cloudflare routing rule.

When moving an existing domain, the instructions must tell the operator to recreate every address that needs to keep receiving mail before changing MX. The MVP does not import historical messages or attachments from another provider.

## 5. Installation and first-run contract

There is no `agentpostoffice install` command. Installation is driven by the README and an agent skill that operates local Wrangler.

The skill must:

1. Detect Node.js, npm, and Wrangler and help install a pinned project-local Wrangler version when needed.
2. Help the user create and configure a least-privilege Cloudflare deployment token.
3. Verify Cloudflare account, zone, token permissions, Workers Paid eligibility, and the chosen `MAIL_DOMAIN`.
4. Create or reuse D1, R2, Queue, DLQ, Worker, Email Routing, Email Sending, and DNS configuration.
5. Apply versioned D1 migrations.
6. Generate the first Agent Post Office token locally, insert only its hash and metadata through D1 SQL, and store the raw token locally for CLI/MCP use.
7. Create at least one operator-selected mailbox before activating inbound routing.
8. Onboard outbound sending and pass the required outbound proof.
9. Show the DNS changes before applying them and then activate routing.
10. Verify live inbound receipt, polling, acknowledgement, send, and reply.

After the user creates the Cloudflare token, the rest of the happy path must be agent-driven without requiring Cloudflare dashboard work. Phase 0 must prove that this is possible through supported APIs and Wrangler.

Installation is resumable and idempotent. A local non-secret configuration records the account ID, zone ID, mail domain, Worker name, and D1/R2/Queue identifiers. Rerunning setup inspects and reuses matching resources instead of blindly recreating or deleting them.

Before setup is declared complete, all of these gates must pass:

- At least one active mailbox exists.
- Arbitrary-recipient sending succeeds on Workers Paid.
- A real external test message passes SPF, DKIM, and DMARC.
- A real inbound message reaches R2, D1, Queue processing, and the polling API.
- A reply threads correctly.

## 6. Architecture

```text
Internet SMTP
    |
    v
Cloudflare Email Routing for ${MAIL_DOMAIN}
    |
    | catch-all -> Worker
    v
Worker email()
    |-- normalize envelope recipient
    |-- reject unknown/disabled recipient
    |-- enforce 10 MiB application limit
    |-- persist byte-exact raw MIME to private R2
    |-- write D1 ingestion row
    `-- enqueue { message_id, raw_r2_key }
                         |
                         v
                    Queue consumer
                         |-- parse MIME idempotently
                         |-- write full bodies/attachments to private R2
                         |-- write 8 KiB excerpt and indexes to D1
                         `-- mark ready or parse_failed

Scheduled or interactive agent
    |
    | Bearer token; HTTPS REST via CLI or MCP
    v
Worker fetch() API -> D1 indexes + private R2 objects
    |
    | send/reply
    v
Cloudflare Email Sending binding -> Internet SMTP
```

Raw email is always written before enqueue. Queue payloads never contain MIME because Queue payload capacity is much smaller than accepted inbound email.

## 7. Agent Post Office token model

Agent Post Office tokens use this format:

```text
apo_<key-id>_<32-byte-random-secret>
```

Authentication works as follows:

1. Parse the public key ID.
2. Fetch exactly one `api_keys` row through the Worker's D1 binding.
3. Hash the presented full token with SHA-256.
4. Compare the digest in constant time.
5. Verify scopes, optional expiry, and `revoked_at`.

D1 stores only the key ID, digest, label, scopes, optional expiry, creation time, and revocation state. Raw tokens remain client-side and should use the OS credential store on macOS and Windows, with a permission-restricted file fallback for Linux and headless environments.

Tokens are domain-wide and cover all current and future mailboxes. Mailbox-specific token restrictions are not in the MVP.

Initial scopes:

- `messages:read`
- `messages:update`
- `messages:reply`
- `messages:send`
- `messages:delete`
- `inboxes:manage`

The default generated token has every scope. Additional tokens may use any subset. Tokens do not expire by default, may have an optional `expires_at`, and are revoked by setting `revoked_at` instead of deleting or reusing the key ID.

Agent Post Office application code only reads `api_keys`; it never inserts, updates, or deletes token rows. The installation documentation must supply Wrangler D1 SQL examples for generating, listing, scoping, expiring, and revoking tokens once the schema exists. There are no token-management API, CLI, or MCP methods.

## 8. Inbound processing contract

1. Normalize the SMTP envelope recipient and find an active mailbox by `(domain, local_part)`.
2. Reject unknown or disabled recipients.
3. Reject raw messages larger than the configurable 10 MiB default.
4. Generate a service message ID.
5. Persist raw RFC 822/MIME bytes to a private R2 key.
6. Insert the D1 ingestion row.
7. Enqueue only the message ID and R2 key.
8. Acknowledge SMTP only after steps 5-7 all succeed.
9. Parse with `postal-mime` in the Queue consumer.
10. Store an 8 KiB normalized plain-text excerpt in D1; store complete text, HTML, raw MIME, and attachments in R2.
11. Mark the message `ready`.

If R2, D1, or enqueue fails, the SMTP transaction must fail so the sender retries. This may create orphan R2 objects or duplicate delivery attempts, which the MVP accepts in exchange for preventing acknowledged-but-invisible mail. Phase 0 must prove Cloudflare's actual retry and acceptance behavior.

Queue delivery and parsing are idempotent. If parsing exhausts retries, the message appears in the normal feed as `parse_failed`, with envelope metadata and authenticated raw download. It must not disappear into an operator-only DLQ.

There is no scheduled repair Cron in the MVP.

Inbound SPF, DKIM, and DMARC results are exposed only if Phase 0 proves Cloudflare supplies a trusted, distinguishable source. Sender-provided authentication headers are ignored. Authentication failure alone does not reject a message; all email content remains `untrusted_content: true`.

## 9. REST API

Base URL:

```text
https://<worker-domain>/v1
Authorization: Bearer <agentpostoffice-token>
```

Tokens are accepted only in the `Authorization` header, never in URLs or query parameters.

### Mailboxes

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| `POST` | `/inboxes` | `inboxes:manage` | Create a logical mailbox/local part. |
| `GET` | `/inboxes` | `messages:read` | List all mailboxes. |
| `GET` | `/inboxes/{inbox_id}` | `messages:read` | Get mailbox state and address. |
| `PATCH` | `/inboxes/{inbox_id}` | `inboxes:manage` | Change display name or enable/disable receipt. |

Normal mailbox removal disables receipt but retains historical messages. Permanent message data deletion uses the message deletion endpoints.

### Unified message feed

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| `GET` | `/messages` | `messages:read` | List messages across every mailbox; optionally filter by `inbox_id`, state, direction, or time. |
| `GET` | `/messages/{message_id}` | `messages:read` | Get the complete parsed message. |
| `PATCH` | `/messages/{message_id}` | `messages:update` | Mark processed/unprocessed or manage simple labels. |
| `GET` | `/messages/{message_id}/raw` | `messages:read` | Stream authenticated `message/rfc822`. |
| `GET` | `/messages/{message_id}/attachments/{attachment_id}` | `messages:read` | Stream one private attachment. |
| `DELETE` | `/messages/{message_id}` | `messages:delete` | Tombstone and asynchronously delete one message and its R2 objects. |
| `POST` | `/messages/bulk-delete` | `messages:delete` | Tombstone and enqueue deletion for up to 100 explicit message IDs; return `202`. |

The main polling request is domain-wide:

```http
GET /v1/messages?state=unprocessed&order=asc&limit=25
Authorization: Bearer <agentpostoffice-token>
```

Mailbox-specific polling uses the same endpoint:

```http
GET /v1/messages?inbox_id=inb_01J...&state=unprocessed&order=asc&limit=25
Authorization: Bearer <agentpostoffice-token>
```

Each list item identifies its mailbox and includes up to 8 KiB of normalized plain text plus `body_truncated`:

```json
{
  "id": "msg_01J...",
  "inbox": {
    "id": "inb_01J...",
    "address": "research@mail.example.com"
  },
  "received_at": "2026-07-10T08:51:00Z",
  "from": { "address": "person@example.net", "name": "Person" },
  "subject": "Question",
  "text": "Bounded normalized plain text...",
  "body_truncated": false,
  "attachments": [],
  "state": "unprocessed",
  "parse_status": "ready",
  "untrusted_content": true
}
```

If `body_truncated` is `false`, the list contains the complete normalized plain-text body. If it is `true`, the client must fetch the full message before replying.

Pagination uses an opaque keyset cursor with a stable tie-breaker such as `(received_at, message_id)`, never offset pagination. Polling is at-least-once: a message remains unprocessed until explicitly acknowledged. There are no claims or leases in the MVP.

Bulk delete accepts explicit IDs only. CLI filters may preview and resolve matches to IDs, but the API does not expose a wildcard delete-all operation.

### Sending and replying

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| `POST` | `/messages` | `messages:send` | Send a new transactional message from an existing active mailbox. |
| `POST` | `/messages/{message_id}/reply` | `messages:reply` | Reply from the mailbox that received the original message. |

New sends specify an existing active `inbox_id`; arbitrary unregistered `From` addresses are rejected. Replies cannot override the sender mailbox. The reply recipient is the trusted parsed `Reply-To` when present, otherwise the original sender. The server preserves `Message-ID`, `In-Reply-To`, and `References`. Reply-all and forwarding are deferred.

Send and reply require an `Idempotency-Key`. The service creates the idempotency row and outbound RFC `Message-ID` before attempting delivery. Once an attempt begins, the same key never sends again. If Cloudflare may have accepted the message but final D1 state could not be written, the API exposes `unknown` instead of risking a duplicate resend.

After the Email Sending binding succeeds, Agent Post Office records `accepted` and Cloudflare's message ID. It never labels that result `delivered`. Immediate binding errors are `failed`. Cloudflare Email Service logs and GraphQL analytics remain the source of truth for final delivery; runtime delivery-status synchronization is not in the MVP. Bounce notifications addressed back to a mailbox are ingested like other inbound mail.

## 10. CLI and MCP behavior

The REST API is the source of truth. The MVP CLI and MCP server wrap its operations; neither duplicates business logic nor writes token rows.

The CLI provides:

- Local credential storage and status without printing secrets.
- Mailbox list/create/enable/disable commands.
- Domain-wide and mailbox-filtered message polling.
- Message get, acknowledge, reply, send, raw download, attachment download, and delete commands.
- Bulk-delete preview and explicit confirmation before sending concrete IDs.

MCP exposes the same API operations as bounded typed tools. Every message body is labeled untrusted. Polling and message tools return normalized plain text by default; HTML requires an explicit API request and is never rendered. Attachment tools return metadata first and download bytes only through an explicit call.

The CLI saves downloaded attachments without opening or executing them. Agent Post Office does not scan attachments for malware and must not claim that it does.

The single default token may be used by CLI and MCP. Additional narrower tokens are optional, not a default installation requirement. CLI/MCP confirmations are guardrails rather than a hard security boundary when the same agent also has arbitrary shell access and the full token.

## 11. Data model and storage

### D1

- `domains`: selected receive/send domain and onboarding state.
- `inboxes`: generated ID, normalized local part, domain, display name, active state, timestamps.
- `api_keys`: public key ID, SHA-256 digest, label, scope set, optional expiry, creation time, revocation time.
- `messages`: generated ID, inbox ID, direction, envelope fields, selected headers, subject, 8 KiB excerpt, R2 keys, parse status, agent state, outbound status, Cloudflare message ID, timestamps.
- `attachments`: generated ID, message ID, private R2 key, filename, media type, disposition, size, checksum.
- `idempotency_keys`: token/key identity, endpoint, request digest, outbound message ID, state, timestamps.
- Queue/DLQ failure metadata or equivalent message status fields.

Schema changes use normal versioned D1 migrations from the first release.

### R2

```text
messages/{inbox-id}/{message-id}/raw.eml
messages/{inbox-id}/{message-id}/parsed.json
messages/{inbox-id}/{message-id}/attachments/{attachment-id}
```

The bucket is private. Object keys use generated IDs, never sender addresses or subjects.

Raw messages, full parsed bodies, and attachments remain indefinitely until explicit deletion. Single and bulk deletion tombstone D1 visibility immediately, then use Queue work to remove every associated R2 object. The MVP has no automatic age-based retention and no scheduled cleanup repair.

## 12. Security and privacy boundaries

- Every subject, body, header, URL, and attachment is hostile input and may contain prompt injection.
- SPF/DKIM/DMARC success authenticates aspects of mail transport; it never makes content trustworthy.
- Route and authorize only from the SMTP envelope and generated internal IDs.
- Store only high-entropy token hashes in D1 and raw tokens client-side.
- Reject unknown recipients and arbitrary outbound sender addresses.
- Use prepared D1 statements, constant-shape authorization failures, bounded request/response sizes, and constant-time token comparison.
- Keep R2 private. Attachment responses use `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
- Do not render active HTML or SVG. HTML retrieval and attachment download are explicit.
- Do not log subjects, bodies, attachment content, bearer tokens, or raw email addresses in application logs by default. Prefer generated IDs.
- Do not accept browser credentials via query strings. No browser UI or permissive CORS policy is required.
- Do not advertise malware scanning, spam filtering, guaranteed delivery, or exactly-once message handling.

There is no Agent Post Office-operated central service. Message bodies and attachments are stored in the operator's Cloudflare account. Cloudflare necessarily processes the mail and currently retains per-event Email Service analytics for 31 days, including sender, recipient, subject, message ID, status, and error details. Documentation must disclose this platform metadata boundary instead of claiming that no third party receives message data.

## 13. Mandatory Phase 0 proof

Phase 0 is a disposable Cloudflare prototype. Production API/schema implementation does not begin until every platform gate passes or the architecture is revised.

1. **Agent-driven install:** after token creation, the skill installs/uses local Wrangler and completes resource creation, DNS, Email Routing, Email Sending, bindings, and verification without Cloudflare dashboard work.
2. **Least-privilege token:** identify and validate the exact Cloudflare permissions required for Workers, DNS, D1, R2, Queues, Email Routing, and Email Sending.
3. **Domain routing:** a catch-all reaches the Worker; active recipients are accepted and unknown recipients are rejected.
4. **Outbound eligibility:** the test account can send to an arbitrary unverified recipient on Workers Paid and returns the expected message ID and errors.
5. **Outbound authentication:** a real external message passes SPF, DKIM, and DMARC.
6. **MIME fidelity:** raw bytes survive Worker-to-R2 persistence byte-for-byte for small, multipart, non-UTF-8, attachment-heavy, and near-10-MiB messages.
7. **SMTP failure semantics:** inject R2, D1, and Queue failures and measure acceptance, rejection, retry, logging, duplicate delivery, and orphan behavior. No SMTP success may occur before all three ingestion operations succeed.
8. **Queue idempotency:** Queue redelivery creates no duplicate message or attachment rows; exhausted parsing appears as `parse_failed` with raw access.
9. **Parser limits:** `postal-mime` remains inside CPU and memory limits near 10 MiB.
10. **Polling correctness:** keyset pagination skips no message across client crashes, same-timestamp arrivals, and new mail during traversal.
11. **Content safety:** raw and attachment download headers prevent inline active-content rendering; MCP/CLI default to plain text and metadata.
12. **Inbound authentication source:** prove whether Cloudflare exposes trusted SPF/DKIM/DMARC results. Omit the API fields if the source cannot be distinguished from sender-supplied headers.
13. **Reply behavior:** replies preserve threading and obey sender-domain and recipient constraints.
14. **Delivery observability:** verify Cloudflare log/GraphQL correlation, hard-bounce notification behavior, soft-bounce retry, and suppression errors without adding a runtime Analytics credential.

## 14. Delivery phases

Engineering uses test-driven development as a hard gate: add an executable failing test before each behavior change, implement the smallest passing change, and require the full test, typecheck, and build suites before handoff. Cloudflare runtime behavior uses the official Workers Vitest integration; live-only SMTP, DNS, and deliverability claims require separate Phase 0 evidence.

### Phase 0: platform proof

Run and document the fourteen mandatory gates above in a temporary domain or subdomain.

### Phase 1: complete agent-operated MVP

- One trusted operator and one custom domain per deployment.
- Agent-guided README/skill installation using local Wrangler.
- Catch-all-to-Worker routing with exact mailbox validation.
- Logical mailbox CRUD.
- Private raw/body/attachment storage.
- Domain-wide message feed plus mailbox filtering.
- Message list/get/acknowledge/raw/attachment operations.
- Single and explicit-ID bulk deletion.
- Transactional send and reply through Cloudflare Email Sending.
- Domain-wide scoped bearer tokens administered through Wrangler D1 SQL.
- REST API, OpenAPI document, CLI, MCP tools, and curl examples.

### Deferred or explicitly out of MVP

- Historical AgentMail or other-provider import.
- Multiple domains, multiple tenants, or mutually untrusted users in one deployment.
- Claims/leases for concurrent consumers.
- Scheduled repair of stale ingestion, parsing, or deletion states.
- Automatic retention and cleanup.
- Application-level outbound quotas, per-recipient limits, and auto-reply loop protection.
- Runtime delivery-status synchronization from Cloudflare GraphQL.
- Attachment-safety pipeline: optional pluggable malware scanning, archive-bomb and recursive-archive limits, declared-type versus magic-byte checks, dangerous-extension policy, password-protected/archive handling, quarantine state, scan-result provenance/versioning, and operator-controlled release/delete workflows. Scanning must run asynchronously with strict CPU, memory, byte, and timeout bounds; attachments remain private and `untrusted_content: true` even after a clean result. The default safe behavior continues to expose metadata first, require explicit download, force attachment disposition plus `nosniff`/sandbox/no-store headers, save with restrictive permissions, and never auto-open or execute content.
- Spam scoring and spam-folder behavior.
- Thread-list APIs, drafts, forwarding, reply-all, full-text search, and advanced labels.
- Backup/restore tooling.
- Storage-usage reporting and hard storage quotas.
- Token-management API/CLI/MCP methods.
- Receive-only free mode.
- Dashboard, webhooks, WebSockets, bulk outreach, and campaigns.

## 15. Accepted MVP risks

- The one default full-permission token has domain-wide blast radius. Narrower tokens are available but optional.
- CLI/MCP safety prompts do not create a hard boundary when an agent has the same full token and arbitrary shell access.
- Polling is at-least-once; overlapping runs may duplicate processing or replies.
- Without a repair Cron, failed partial ingestion can leave orphan R2 objects and failed deletion can leave tombstoned objects behind.
- Indefinite retention without usage reporting or hard quotas permits unbounded storage growth and cost.
- Cloudflare Email Sending is a paid, beta platform dependency.
- Agent Post Office records send acceptance, not guaranteed delivery.
- Cloudflare retains Email Service event metadata independently of Agent Post Office application logging.

## Sources

- [AgentMail inbox capabilities](https://docs.agentmail.to/knowledge-base/inbox-capabilities)
- [AgentMail messages](https://docs.agentmail.to/messages.md)
- [AgentMail custom domains](https://docs.agentmail.to/custom-domains.md)
- [Cloudflare Email Service](https://developers.cloudflare.com/email-service/)
- [Cloudflare inbound email Worker API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
- [Cloudflare email storage and Queue example](https://developers.cloudflare.com/email-service/examples/email-routing/email-storage/)
- [Cloudflare domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/)
- [Cloudflare routing rules and catch-all](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)
- [Cloudflare Email Sending Worker API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [Cloudflare Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/)
- [Cloudflare Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/)
- [Cloudflare deliverability](https://developers.cloudflare.com/email-service/concepts/deliverability/)
- [Cloudflare suppression lists](https://developers.cloudflare.com/email-service/concepts/suppressions/)
- [Cloudflare Email Service logs](https://developers.cloudflare.com/email-service/observability/logs/)
- [Cloudflare Email Service analytics](https://developers.cloudflare.com/email-service/observability/metrics-analytics/)
- [Cloudflare API-token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
