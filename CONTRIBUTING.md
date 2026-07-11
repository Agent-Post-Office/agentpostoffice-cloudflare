# Contributing

Agent Post Office is in developer preview. Small, focused changes with explicit security and Cloudflare-runtime assumptions are easiest to review.

## Development workflow

Use Node.js 20 or newer and install the locked dependency graph:

```bash
npm ci
```

Development is test-driven. Add or change an executable test first, run the narrow test to observe the intended failure, implement the smallest change, then run every repository gate:

```bash
npm test
npm run check
npm run build
```

Behavior involving Workers, D1, R2, Queues, or Email bindings must use the official Cloudflare Workers Vitest pool. Local tests do not prove real SMTP, DNS, authentication, retry, or delivery behavior; those claims require sanitized evidence under `docs/phase-0-results/` and explicit operator approval before live actions.

## Pull requests

- Keep pull requests scoped and explain the user-visible behavior and security boundary.
- Do not include tokens, message content, subjects, attachments, raw addresses, or private Cloudflare identifiers.
- Update OpenAPI, client types, CLI/MCP behavior, and documentation together when an API contract changes.
- Do not weaken tests, bypass mailbox validation, render untrusted content, or broaden credentials to make a change pass.

Use GitHub issues for bugs and feature proposals. Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).
