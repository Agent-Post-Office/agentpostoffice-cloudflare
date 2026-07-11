# Agent Post Office security review

Date: 2026-07-11
Scope: `packages/worker`, `packages/client`, `packages/cli`, `packages/mcp`, provisioning/token tools, migrations, API specification, and security/install documentation.
Method: hostile-flow source review of authentication, authorization, inbound SMTP, outbound sending/replies, D1/R2/Queue persistence, deletion, local credential handling, MCP tools, untrusted content, and dependency/configuration posture. No live Cloudflare resources, DNS, or real mail were changed.

## Executive summary

The project has a strong baseline: high-entropy hashed bearer tokens, constant-time digest comparison, explicit scopes, parameterized D1 queries, private object storage, safe download headers, HTML opt-in, untrusted-content labeling, bounded API bodies, idempotent outbound sends, and careful avoidance of sensitive logging. The test, type-check, OpenAPI, build, and dependency-audit baselines all pass.

The review originally found two high-severity trust-boundary defects, three medium-severity hardening gaps, and one low-severity documentation/integrity mismatch. Every finding now has an explicit final disposition: four remediated, one accepted as operator-controlled deployment policy, and one accepted/deferred with monitoring and roadmap guidance.

No evidence of SQL injection, token-in-URL handling, cross-mailbox authorization bypass outside the intentional domain-wide operator model, automatic HTML rendering, arbitrary outbound `From`, or known vulnerable npm dependencies was found.

## High severity

### APO-SEC-001 — Deletion can become unrecoverable after Queue admission failure

**Status:** Remediated on 2026-07-11. Single and bulk deletion now re-enqueue existing tombstoned records, with Workers integration tests covering Queue admission failure followed by a successful retry.

**Impact:** A delete request can report an error while permanently hiding the message from all API retry paths even though its raw email, parsed body, and attachments remain stored in R2/D1.

**Evidence:**

- Single deletion tombstones the D1 row before calling `MAIL_QUEUE.send` (`packages/worker/src/api.ts:245-251`).
- All message reads and subsequent single-delete retries exclude tombstoned rows (`packages/worker/src/api.ts:307-312`).
- Bulk deletion tombstones every row before `sendBatch` (`packages/worker/src/api.ts:254-275`). If `sendBatch` fails, a retry does not enqueue those IDs because the update requires `tombstoned_at IS NULL`.
- Physical deletion occurs only in the asynchronous Queue consumer (`packages/worker/src/queue.ts:126-136`).
- The current test proves immediate tombstoning but does not inject Queue failure into deletion (`packages/worker/test/api.test.ts:106-115`).

**Attack/failure path:** A transient Queue outage or binding failure occurs after the tombstone commit. The request fails, the content remains stored, and the API returns 404 or an empty queued-ID list on retry. This is a privacy and retention failure even without an attacker; an attacker able to induce resource pressure can increase its likelihood.

**Recommendation:** Use a recoverable deletion state machine. Persist `deletion_status = 'pending'`, enqueue using an outbox/dispatcher that can be retried, and keep an idempotent operator-visible retry path for pending/failed deletion. Do not make the only enqueue attempt after irreversibly excluding the record from every API path. Add Worker-pool tests for single and batch Queue-admission failure, redelivery, DLQ/exhaustion, and eventual removal of every R2 object and D1 row.

### APO-SEC-002 — MCP download tools are an arbitrary local file-write primitive for hostile email content

**Status:** Remediated on 2026-07-11. MCP downloads are confined to a configured directory, accept filenames only, require explicit confirmation before fetching bytes, and retain create-only `0600` writes. Tests cover absolute paths, traversal, existing files, and symlink targets.

**Impact:** A remote sender can combine a malicious attachment/raw message with prompt injection that persuades an agent to create a security-sensitive local file, potentially planting credentials or persistence material under the MCP process account.

**Evidence:**

- All email content is explicitly recognized as potentially prompt-injecting (`docs/SECURITY.md:3-12`).
- `save_raw_message` and `save_attachment` accept any non-empty `output_path`, resolve it to an absolute path, create parent directories, and write remote-controlled bytes (`packages/mcp/src/server.ts:99-119,135-142`).
- The tools have no configured download root/path containment rule. Unlike delete and HTML tools, they also have no literal confirmation/acknowledgement field.
- `flag: "wx"` and mode `0600` prevent overwrite and reduce permissions, but they do not prevent creation of a previously absent sensitive file such as an SSH authorization file, application config, or autoloaded data file.

**Recommendation:** Restrict MCP downloads to a dedicated operator-configured directory and accept only a server-generated filename or sanitized basename. Verify with `realpath`/parent containment and reject symlink traversal. Require a literal operator confirmation for active or unknown content, and return attachment metadata first so policy can decide whether bytes may be saved. Treat caller-selected arbitrary paths as a separate privileged tool, disabled by default.

## Medium severity

### APO-SEC-003 — Full-permission bearer token is exposed through argv, shell history, and stdout-oriented setup

**Status:** Remediated on 2026-07-11. The npm token-management scripts and helper were removed. Agent-operated setup now generates the credential in a non-exported local variable, inserts only its digest and metadata with Wrangler, and sends the raw token through validated stdin directly to the OS keyring. The CLI rejects `--token` argv input.

**Evidence:**

- `token:create` prints the raw token and a complete command containing it (`tools/token.ts:14-30`).
- CLI configuration requires `--token`, which places the secret in process arguments and commonly in shell history (`packages/cli/src/index.ts:17-22,174-183`).
- README and install docs repeat that command shape (`README.md:128-140,215-228`; `docs/INSTALL.md:95-109`).
- The default token has all domain permissions, including send, reply, delete, and mailbox management (`tools/token.ts:20-23`).

**Risk:** Terminal capture, CI logs, agent transcripts, shell history, or same-host process inspection can expose the single-operator administration credential. Storing the token in the OS keyring afterward does not remove those prior copies.

**Recommendation:** Add a non-echoing stdin/TTY prompt or `--token-stdin` path and make it the documented default. Have token creation optionally store directly into the keyring without printing the raw value, or emit it only to an explicitly selected protected file descriptor. Keep stdout machine-readable and secret-free. Update examples to avoid literal secrets in argv and rotate any token that has appeared in retained logs/transcripts.

### APO-SEC-004 — Client permits bearer transmission over non-loopback HTTP

**Status:** Accepted as operator responsibility on 2026-07-11. Normal Cloudflare Workers and custom-domain deployments use HTTPS, while local development may intentionally use loopback HTTP. Installation documentation consistently uses HTTPS; no client restriction was added.

**Evidence:**

- The client explicitly accepts both HTTP and HTTPS base URLs (`packages/client/src/index.ts:76-81`).
- Every request sends the full bearer token in `Authorization` (`packages/client/src/index.ts:188-192`).
- CLI configuration preserves any URL accepted by `new URL` (`packages/cli/src/config.ts:22-29`).

**Risk:** A mistaken `http://` production configuration exposes the full-permission bearer credential and message data to network interception. Documentation uses HTTPS, but the reusable client does not enforce it.

**Recommendation:** Require HTTPS by default. Permit HTTP only for explicit loopback hosts (`localhost`, `127.0.0.0/8`, `::1`) or behind a clearly named development override. Add client tests that reject non-loopback HTTP and credential-bearing redirects to a different origin.

### APO-SEC-005 — Public endpoints have no effective abuse/cost controls before durable work

**Status:** Accepted and deferred for the MVP on 2026-07-11. The README records the remaining rate-limit, ingress-budget, retention, and emergency-control roadmap and requires account-wide Cloudflare budget alerts, plan-dependent per-product usage notifications, and weekly Workers/R2/D1/Queues cost review before production use.

**Evidence:**

- Every syntactically valid bearer attempt causes a D1 lookup before rejection (`packages/worker/src/auth.ts:14-29`), with no application or platform rate-limit configuration in the repository.
- Any sender who knows an active mailbox can submit messages up to 10 MiB, causing full buffering, R2 storage, D1 writes, Queue work, MIME parsing, parsed-object storage, and attachment hashing (`packages/worker/src/inbound.ts:13-90`; `packages/worker/src/queue.ts:24-117`).
- Retention is indefinite and the project explicitly does not provide spam filtering or quotas (`README.md:43-56`; `docs/SECURITY.md:11-13`).

**Risk:** Invalid-token floods can generate D1 cost/latency, while mail bombs to a known mailbox can consume storage, Queue, CPU/memory, and operator attention. The 10 MiB per-message cap limits individual requests but not aggregate abuse.

**Recommendation:** Document and ship a minimum platform-side rate-limit/budget policy for API authentication failures. Add per-mailbox/domain storage and ingress budgets with an SMTP failure policy, plus operational alerts. If quotas remain intentionally deferred, record this as an accepted production availability/cost risk and provide a tested emergency disable/cleanup procedure.

## Low severity

### APO-SEC-006 — Attachment integrity guidance and MCP behavior do not match

**Status:** Remediated on 2026-07-11. MCP attachment saves now require matching stored metadata, enforce the stored size and caller maximum before writing, verify SHA-256 over the downloaded bytes, and create the local file only after verification succeeds.

**Evidence:**

- Security guidance says integrations should verify the recorded attachment checksum (`docs/SECURITY.md:15-19`).
- Attachment metadata exposes `checksum_sha256` (`packages/worker/src/api.ts:368-376`).
- The MCP save tool downloads and writes bytes but never retrieves or verifies that checksum (`packages/mcp/src/server.ts:91-119,135-142`).
- README says attachment tools return metadata only even though `save_attachment` downloads bytes (`README.md:248-258`; `packages/mcp/src/server.ts:108-120`).

**Risk:** Operators may assume the documented integrity check occurred, and the inaccurate README understates the MCP tool's local-write capability.

**Recommendation:** Verify SHA-256 before finalizing the local file (download to a protected temporary file, compare, then atomically rename) and return the verified digest. Correct the README to distinguish metadata-only inspection from explicit byte download.

## Positive controls confirmed

- Bearer tokens have 256-bit random secrets, D1 stores only SHA-256 digests, and comparison is constant-time (`tools/token.ts:14-18`; `packages/worker/src/auth.ts:14-39`; `packages/worker/src/util.ts:31-47`).
- Tokens are accepted only from `Authorization`, not URLs; errors do not echo credentials (`packages/worker/src/auth.ts:14-17,48-51`; `packages/worker/test/api.test.ts:29-34`).
- Scope checks guard every protected route (`packages/worker/src/api.ts:41-163`).
- SQL values are parameterized; the only dynamic query fragments are bounded enum-derived ordering/comparison and generated placeholders (`packages/worker/src/api.ts:166-205,315-323`).
- Inbound routing uses the SMTP envelope recipient and rejects unknown/disabled mailboxes before storage (`packages/worker/src/inbound.ts:13-41`).
- Outbound `From` is derived only from an active D1 inbox whose domain matches `MAIL_DOMAIN` (`packages/worker/src/outbound.ts:21-35,126-171,214-220`).
- Raw and attachment responses force download, disable sniffing/caching, and apply a sandbox CSP (`packages/worker/src/api.ts:278-299,379-387`).
- Normal message retrieval omits HTML unless explicitly requested; MCP HTML access requires explicit acknowledgement (`packages/worker/src/api.ts:209-229`; `packages/mcp/src/server.ts:49-57`).
- Logs avoid tokens, message content, subjects, attachments, and raw addresses in reviewed paths.
- Outbound requests use per-token/endpoint idempotency records to prevent duplicate sends after ambiguous results (`packages/worker/src/outbound.ts:79-123,163-211`).

## Verification results

- `npm test`: passed, 13 test files / 43 tests.
- `npm run check`: passed, including TypeScript checks and OpenAPI lint.
- `npm run build`: passed for client, CLI, MCP, and Worker.
- `npm audit --omit=dev`: 0 known vulnerabilities.
- `npm audit`: 0 known vulnerabilities.
- Live MCP attachment verification passed against a sanitized 7.6 MB mailbox test case: stored size and SHA-256 matched, the file was created as `0600`, never opened, and removed afterward.
- Live Cloudflare SMTP retry/failure injection, near-limit parser behavior, active SVG, and delivery-observability gates remain pending in `docs/PHASE-0.md`; this review does not claim those behaviors are proven.

## Final disposition

1. APO-SEC-001: remediated with retryable deletion admission and failure-injection tests.
2. APO-SEC-002: remediated with confirmed, directory-confined, create-only MCP downloads.
3. APO-SEC-003: remediated by removing token scripts and accepting CLI credentials only through stdin.
4. APO-SEC-004: accepted as operator-controlled deployment policy.
5. APO-SEC-005: accepted/deferred with roadmap, Cloudflare budget alerts, and monitoring guidance.
6. APO-SEC-006: remediated with size and SHA-256 verification before MCP file creation.
