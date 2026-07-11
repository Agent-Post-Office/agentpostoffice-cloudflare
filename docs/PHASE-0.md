# Mandatory Cloudflare Phase 0 proof

Status: **in progress**. Local tests are green; active-recipient inbound receipt, external delivery, authentication, direct send, and threaded reply are proven. Failure semantics, boundary MIME cases, and delivery observability remain incomplete.

Run this checklist on a disposable domain or subdomain. Save sanitized evidence under `docs/phase-0-results/YYYY-MM-DD-domain.md`. Never record API tokens, Agent Post Office bearer tokens, subjects, bodies, attachments, or complete sender/recipient addresses.

| Gate | Required evidence | Status |
| --- | --- | --- |
| Agent-driven install | Commands and resource IDs showing setup completed after user token creation without dashboard steps. | Pending |
| Least-privilege token | Exact Cloudflare permissions and successful/failed API calls proving no extra permission is needed. | Pending |
| Domain routing | Active recipient accepted; unknown and disabled recipients rejected by the catch-all Worker. | Active recipient passed; unknown/disabled pending |
| Outbound eligibility | Arbitrary unverified recipient send on Workers Paid returns a message ID; entitlement errors recorded safely. | Passed for direct send and external delivery; entitlement failure was observed before onboarding. |
| Outbound authentication | External header analysis shows SPF, DKIM, and DMARC pass. | Passed from sanitized external header inspection. |
| MIME fidelity | Byte hashes match for small, multipart, non-UTF-8, attachment-heavy, and near-10-MiB raw messages. | Partial: a live binary attachment matched its stored size and checksum; remaining corpus pending. |
| SMTP failure semantics | Injected R2, D1, and Queue failures establish rejection/retry/duplicate/orphan behavior and prove no premature SMTP success. | Pending |
| Queue idempotency | Redelivery adds no duplicate message/attachment rows; exhausted parse work becomes `parse_failed` with raw access. | Pending locally; live pending |
| Parser limits | Near-10-MiB parse stays inside the deployed Worker's CPU and memory limits. | Pending |
| Polling correctness | Client-crash, same-timestamp, and concurrent-arrival traversal shows no skipped IDs. | Passed locally; live pending |
| Content safety | Raw/SVG/HTML/attachment downloads are attachments with `nosniff` and sandboxing; clients do not render/open them. | Partial: local active-content tests and a live binary attachment passed; live HTML/SVG pending. |
| Inbound authentication source | Cloudflare-provided SPF/DKIM/DMARC source is distinguishable from sender-supplied headers, or fields remain omitted. | Pending |
| Reply behavior | Real reply uses the receiving mailbox, correct recipient constraints, `Message-ID`, `In-Reply-To`, and `References`. | Passed from sanitized recipient-side header and thread inspection. |
| Delivery observability | Email Service logs/GraphQL correlate sends; hard bounce, soft retry, and suppression behavior are recorded without a runtime analytics secret. | Pending |

## Failure injection rules

- Use a disposable sender/recipient and non-sensitive bodies.
- Introduce one failure at a time and capture generated IDs rather than addresses/content.
- Confirm whether a thrown `email()` handler error is a temporary SMTP failure. Do not substitute `setReject()`, which is a permanent policy rejection.
- Inspect R2, D1, Queue, DLQ, Worker logs, Email Service logs, and the polling API after each attempt.
- Repeat delivery to distinguish retries from separate SMTP sends.

## Completion decision

Phase 0 passes only when every row has current evidence. If Cloudflare behavior contradicts the architecture—especially SMTP acknowledgement timing, API-only onboarding, arbitrary-recipient sending, or trusted authentication results—stop deployment and revise `AGENTPOSTOFFICE-PLAN.md` before proceeding.
