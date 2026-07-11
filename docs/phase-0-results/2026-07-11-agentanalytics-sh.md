# Phase 0 partial evidence: 2026-07-11

Status: **in progress**. This file records sanitized infrastructure and live-path conclusions. Exact recipients, subjects, bodies, attachments, sizes, checksums, timestamps, IPs, and transport identifiers are intentionally omitted.

## Inbound routing configuration

- The renamed Worker health endpoint returned HTTP 200 with service identifier `agentpostoffice`.
- The existing D1 database, R2 bucket, parse queue, and dead-letter queue were reused.
- Both Queue consumers were transferred from the earlier Worker identifier to `agentpostoffice` with their existing batch, retry, and dead-letter settings.
- Two intended application mailboxes exist and are active; complete addresses are intentionally omitted.
- Cloudflare Email Routing reports `enabled: true` and `status: ready`.
- The enabled catch-all rule has an `all` matcher and a single Worker action targeting `agentpostoffice`.
- The previous non-Cloudflare apex MX was removed after operator approval.
- Public resolvers return all three Cloudflare Email Routing MX records.
- Cloudflare's authoritative nameservers return the managed routing SPF and DKIM records.

## Still pending

- Inbound byte fidelity and independent authentication interpretation remain to be checked.
- Unknown and disabled recipient behavior must be exercised over SMTP.
- Final outbound delivery/header authentication, failure-injection, parser-limit, and observability gates remain pending.

## First live inbound attempts

- Three non-sensitive test messages reached Cloudflare Email Routing.
- Cloudflare reported SPF and DKIM pass, then a temporary Worker failure for each attempt.
- Workers Observability identified the failure as R2 rejecting an arbitrary inbound `ReadableStream` without a known length.
- The failure was reproduced with a new official Workers/R2 runtime test before implementation.
- The Worker now materializes the already size-bounded stream into byte-exact fixed-size data before R2 persistence; the focused tests and full local suite pass.
- A post-fix real inbound retry arrived successfully.

## Post-fix inbound receipt

- One non-sensitive test message was accepted through the active catch-all Worker route.
- Generated message ID: `msg_0mrgc7ugc52004c5aed99525d65293107`.
- The message reached `parse_status: ready`, retained content, and had zero attachments.
- Sanitized parsed-content fingerprint: `884ae224d324c438`.
- The polling API returned the message as unprocessed.
- Explicit acknowledgement succeeded, after which the message was absent from the unprocessed feed.
- This proves the active-recipient receive/poll/ack happy path. Unknown and disabled recipient SMTP behavior remains pending.

## First live reply attempt

- The initial threaded reply was rejected before transmission by Cloudflare Email Sending.
- Cloudflare rejected the custom `Message-ID` header; the failed idempotency key remains permanently failed and was not reused.
- A new test first reproduced the invalid request shape.
- The Worker now preserves `In-Reply-To` and `References` while allowing Cloudflare to generate the outbound `Message-ID`.
- The focused test and full local suite passed before deployment.

## Email Sending onboarding and accepted reply

- Cloudflare Email Sending was onboarded for the apex domain and reports the sending domain enabled.
- Cloudflare installed three bounce MX records plus managed bounce SPF and DKIM records.
- The pre-existing DMARC policy sent aggregate reports to a former provider. With explicit operator approval, that reporting destination was removed while preserving `p=reject`.
- Cloudflare's authoritative nameserver returned the resulting single DMARC policy without the former reporting destination.
- A fresh post-onboarding threaded reply was accepted and returned a Cloudflare provider message identifier.
- Sanitized external inspection subsequently confirmed delivery, SPF, DKIM, DMARC, TLS transport, and correct reply-thread headers and conversation placement.
- A separate direct send to an unverified external recipient was delivered successfully.

## Sanitized attachment-safety conclusion

- A non-sensitive binary attachment was parsed, stored privately, and downloaded without being opened.
- Downloaded bytes matched the stored size and checksum.
- The live response forced attachment disposition and returned `nosniff`, sandbox, and private no-store protections.
- The CLI saved the file with owner-only permissions and refused to overwrite an existing path.
- Exact message and attachment details are deliberately not retained in this evidence file. Live HTML/SVG active-content checks remain pending.
