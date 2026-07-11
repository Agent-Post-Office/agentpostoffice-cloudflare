# Mandatory Cloudflare Phase 0 proof

Status: **in progress**. Local tests are green; active-recipient inbound receipt, external delivery, authentication, direct send, and threaded reply are proven. Failure semantics, boundary MIME cases, and delivery observability remain incomplete.

Current result: **6 passed, 6 partial, 2 pending**. A partial result does not satisfy Phase 0 completion.

Run this checklist on a disposable domain or subdomain. Save sanitized evidence under `docs/phase-0-results/YYYY-MM-DD-domain.md`. Never record API tokens, Agent Post Office bearer tokens, subjects, bodies, attachments, or complete sender/recipient addresses.

| Gate | Required evidence | Status |
| --- | --- | --- |
| Agent-driven install | Commands and resource IDs showing setup completed after user token creation without dashboard steps. | 🟡 Partial — the agent completed provisioning and verification, but dashboard steps were required. |
| Least-privilege token | Exact Cloudflare permissions and successful/failed API calls proving no extra permission is needed. | 🟡 Partial — a one-account/one-zone setup token worked for scoped Email/DNS operations, but OAuth and dashboard actions mean the complete minimum set is not proved. |
| Domain routing | Active recipient accepted; unknown and disabled recipients rejected by the catch-all Worker. | ✅ Passed — active-recipient delivery succeeded, an unrouted recipient received a permanent SMTP rejection, and a routed but disabled D1 mailbox received the Worker's permanent `555 5.7.1` rejection. |
| Outbound eligibility | Arbitrary unverified recipient send on Workers Paid returns a message ID; entitlement errors recorded safely. | ✅ Passed — direct send returned a provider ID and external delivery succeeded; the pre-onboarding entitlement failure was recorded safely. |
| Outbound authentication | External header analysis shows SPF, DKIM, and DMARC pass. | ✅ Passed — sanitized external header inspection confirmed all three. |
| MIME fidelity | Byte hashes match for small, multipart, non-UTF-8, attachment-heavy, and near-10-MiB raw messages. | 🟡 Partial — live multipart/HTML, binary-attachment, and just-below-limit paths passed, and an above-limit message was rejected before persistence; non-UTF-8 and attachment-heavy corpus checks remain. |
| SMTP failure semantics | Injected R2, D1, and Queue failures establish rejection/retry/duplicate/orphan behavior and prove no premature SMTP success. | ⬜ Pending |
| Queue idempotency | Redelivery adds no duplicate message/attachment rows; exhausted parse work becomes `parse_failed` with raw access. | 🟡 Partial — idempotent redelivery and `parse_failed` handling pass locally; live Queue/DLQ proof remains. |
| Parser limits | Near-10-MiB parse stays inside the deployed Worker's CPU and memory limits. | ✅ Passed — an above-limit message received the configured permanent SMTP rejection, while a just-below-limit message was accepted, parsed to `ready`, and preserved attachment bytes and checksum. |
| Polling correctness | Client-crash, same-timestamp, and concurrent-arrival traversal shows no skipped IDs. | 🟡 Partial — same-timestamp keyset traversal passes locally and live poll/ack passed; crash and concurrent-arrival live traversal remain. |
| Content safety | Raw/SVG/HTML/attachment downloads are attachments with `nosniff` and sandboxing; clients do not render/open them. | 🟡 Partial — local active-content tests plus live binary-attachment and HTML-message paths passed; live SVG remains. |
| Inbound authentication source | Cloudflare-provided SPF/DKIM/DMARC source is distinguishable from sender-supplied headers, or fields remain omitted. | ✅ Passed — the API omits authentication-result fields rather than exposing sender-supplied headers as trusted results. |
| Reply behavior | Real reply uses the receiving mailbox, correct recipient constraints, `Message-ID`, `In-Reply-To`, and `References`. | ✅ Passed — sanitized recipient-side inspection confirmed delivery, sender identity, generated ID, and thread headers. |
| Delivery observability | Email Service logs/GraphQL correlate sends; hard bounce, soft retry, and suppression behavior are recorded without a runtime analytics secret. | ⬜ Pending |

## Failure injection rules

- Use a disposable sender/recipient and non-sensitive bodies.
- Introduce one failure at a time and capture generated IDs rather than addresses/content.
- Confirm whether a thrown `email()` handler error is a temporary SMTP failure. Do not substitute `setReject()`, which is a permanent policy rejection.
- Inspect R2, D1, Queue, DLQ, Worker logs, Email Service logs, and the polling API after each attempt.
- Repeat delivery to distinguish retries from separate SMTP sends.

## Completion decision

Phase 0 passes only when every row has current evidence. If Cloudflare behavior contradicts the architecture—especially SMTP acknowledgement timing, API-only onboarding, arbitrary-recipient sending, or trusted authentication results—stop deployment and revise `AGENTPOSTOFFICE-PLAN.md` before proceeding.
