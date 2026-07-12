# Phase 0 partial evidence: 2026-07-11

This file intentionally omits addresses, message content, subjects, API tokens, and provider-specific message identifiers.

## Domain routing

- The intended active recipient has an enabled exact Cloudflare Email Routing rule targeting the isolated Worker.
- An external SMTP attempt to an unrouted recipient received a permanent `550 5.1.1` address-not-found response.
- A temporary mailbox was created in D1, disabled through the authenticated API, and given an exact route to the Worker.
- An external SMTP attempt to that routed but disabled mailbox received the Worker's permanent `555 5.7.1 Unknown or disabled recipient` response.
- The temporary route and mailbox were removed after the proof.

Result: passed.

## Sieve autoresponder live proof

- The additive schema migration and separate Automation Queue/DLQ were deployed with zero active scripts.
- One inactive Sieve revision was validated and stored for the central installation-check mailbox.
- A dry run against a non-matching historical message produced no action.
- The revision was explicitly activated only after validation and dry-run inspection.
- An external standardized check produced one claimed execution and one accepted automatic reply; queue redelivery did not create another recent reply.
- Recipient-side inspection confirmed `In-Reply-To` and `References` threading metadata.
- The first live attempt exposed Cloudflare's managed bounce return path. The implementation now unwraps that sender only when the parsed visible sender domain exactly matches the owner of `cf-bounce.<domain>`; a mismatched-domain reflection case is suppressed by a workerd integration test.
- The Automation DLQ has its intended Worker consumer and no failure was observed during the successful proof.

Result: passed for the central Sieve autoresponder vertical slice.
