# Phase 0 partial evidence: 2026-07-11

This file intentionally omits addresses, message content, subjects, API tokens, and provider-specific message identifiers.

## Domain routing

- The intended active recipient has an enabled exact Cloudflare Email Routing rule targeting the isolated Worker.
- An external SMTP attempt to an unrouted recipient received a permanent `550 5.1.1` address-not-found response.
- A temporary mailbox was created in D1, disabled through the authenticated API, and given an exact route to the Worker.
- An external SMTP attempt to that routed but disabled mailbox received the Worker's permanent `555 5.7.1 Unknown or disabled recipient` response.
- The temporary route and mailbox were removed after the proof.

Result: passed.
