# Phase 0 partial evidence: 2026-07-11

Status: **in progress**. This file contains infrastructure-state evidence only. It does not prove real SMTP receipt or outbound delivery.

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

- A real inbound message must be received, polled, acknowledged, and checked for byte and authentication behavior.
- Unknown and disabled recipient behavior must be exercised over SMTP.
- Email Sending onboarding and every outbound, reply, failure-injection, parser-limit, and observability gate remain pending.

## First live inbound attempts

- Three non-sensitive test messages reached Cloudflare Email Routing.
- Cloudflare reported SPF and DKIM pass, then a temporary Worker failure for each attempt.
- Workers Observability identified the failure as R2 rejecting an arbitrary inbound `ReadableStream` without a known length.
- The failure was reproduced with a new official Workers/R2 runtime test before implementation.
- The Worker now materializes the already size-bounded stream into byte-exact fixed-size data before R2 persistence; the focused tests and full local suite pass.
- A post-fix real inbound retry is still required before marking receipt as passed.
