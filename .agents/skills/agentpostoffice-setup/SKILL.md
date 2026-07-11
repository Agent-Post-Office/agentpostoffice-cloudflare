---
name: agentpostoffice-setup
description: Provision, resume, verify, or diagnose a self-hosted Agent Post Office deployment in the user's Cloudflare account. Use for Agent Post Office setup, D1/R2/Queue creation, Wrangler configuration, Email Sending onboarding, Email Routing catch-all activation, token creation, mailbox bootstrap, DNS review, or the mandatory live Phase 0 proof.
---

# Agent Post Office setup

Work from the Agent Post Office monorepo root. Read `docs/INSTALL.md` and `docs/PHASE-0.md` before live changes.

## Guardrails

- Never deploy, change DNS/MX, activate routing, or send real mail without explicit user authorization.
- Never print or store Cloudflare tokens or Agent Post Office bearer tokens in logs, source, chat summaries, or evidence.
- Show DNS and routing changes before applying them.
- Reuse matching resources. Never delete or recreate resources merely to make setup simpler.
- Do not broaden a Cloudflare token without identifying the failing operation and required permission.
- Do not claim production readiness from local tests. Record each live Phase 0 gate separately.

## Workflow

1. Verify Node.js 20+, npm, local Wrangler, repository location, working tree state, Cloudflare identity, Workers Paid eligibility, zone ownership, and the full user-selected `MAIL_DOMAIN`.
2. Run `npm install`, `npm test`, `npm run check`, and `npm run build`. Stop on failure.
3. Ask the user to create a least-privilege Cloudflare token if none is available. Keep it outside the Worker and repository.
4. Run `npm run config:generate -- --mail-domain <domain>`. Inspect the generated `packages/worker/wrangler.jsonc`; confirm D1, R2, Queue, DLQ, Worker, and binding names.
5. Onboard Email Sending with current supported Cloudflare APIs. Show proposed SPF, DKIM, DMARC, bounce, and other DNS records before applying them.
6. Deploy the Worker and apply remote migrations. Follow section 5 of `docs/INSTALL.md`: generate the first token in a non-exported local shell variable, insert only its digest and metadata with `wrangler d1 execute`, and pipe the raw token through `--token-stdin` directly into the OS keyring. Never print or repeat it. Before production use, have the operator configure or explicitly defer the budget and usage alerts in the README security roadmap.
7. Create at least one operator-selected mailbox through the CLI before inbound routing. Never invent `support`, `contact`, or another local part.
8. Show the proposed Email Routing/MX changes and catch-all-to-Worker rule. Apply only after explicit approval.
9. Run all fourteen gates in `docs/PHASE-0.md`, including real inbound polling/acknowledgement, arbitrary-recipient send, threaded reply, failure injection, MIME hashes, DNS authentication, and delivery observability.
10. Write sanitized generated-ID evidence under `docs/phase-0-results/`. Mark setup complete only if every gate passes; otherwise revise the architecture or report the exact blocker.

## Resuming

Inspect the generated Wrangler config and live resource lists before running creation commands. Treat an existing resource with matching name and binding as reusable only after confirming its account, zone, and purpose. Reapply versioned migrations safely, then continue from the first unproven Phase 0 gate.
