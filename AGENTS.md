# Agent Post Office engineering instructions

## Monorepo

- `packages/worker`: Cloudflare Worker, D1 migrations, R2/Queue/email bindings.
- `packages/client`: reusable REST client and public TypeScript types.
- `packages/cli`: local agent/operator CLI.
- `packages/mcp`: shared MCP tool catalog and the local stdio server. The Worker serves the same tools, except the filesystem saves, at `POST /mcp`.
- `packages/openapi`: source-of-truth OpenAPI document.
- `tools`: local provisioning and token-administration helpers.

## Required workflow

Use test-driven development. Add or change an executable test before implementation code, run the narrow test to observe the failure, implement the smallest change, then run `npm test`, `npm run check`, and `npm run build` before handoff.

Never weaken a test to make an implementation pass. Use the official Cloudflare Workers Vitest pool for behavior involving D1, R2, Queues, or Worker runtime semantics.

## Live Cloudflare boundary

Local tests do not prove SMTP retry behavior, arbitrary-recipient sending, DNS authentication, or real delivery. Do not deploy, change DNS/MX, activate Email Routing, or send a real message unless the user explicitly authorizes that live action. Record live proof against `docs/PHASE-0.md` and never store API tokens, Agent Post Office bearer tokens, message content, or raw addresses in evidence files.
