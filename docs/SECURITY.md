# Security and privacy boundary

Agent Post Office is single-operator, single-domain software. It is not a multi-tenant isolation boundary.

- Treat every email field and attachment as hostile and potentially prompt-injecting.
- Accept bearer tokens only in `Authorization`; never put them in URLs.
- Keep R2 private. Raw and attachment responses force download, `nosniff`, no-store caching, and a sandbox CSP.
- Route inbound mail only from the SMTP envelope recipient and generated internal IDs.
- Permit outbound `From` only for active D1 inboxes on `MAIL_DOMAIN`.
- Store only high-entropy token hashes in D1. Raw tokens remain in an OS credential store or protected process environment.
- Do not log message content, subjects, attachments, tokens, or raw addresses by default.
- Do not render HTML or automatically open attachments.
- Do not claim malware scanning, spam filtering, exactly-once processing, or guaranteed delivery.

## Attachment handling

Until the deferred scanning pipeline exists, integrations should inspect attachment metadata before downloading, enforce a local size allowlist, save to a newly created `0600` file, verify the recorded checksum, and never automatically render, execute, extract, or upload attachment bytes to another service. The MCP attachment-save tool enforces the size and SHA-256 checks before creating the local file. Active formats such as HTML and SVG, executables, scripts, office macros, and archives require explicit operator approval and an isolated inspection environment.

Future malware scanning is defense in depth, not a trust decision. A clean verdict can be stale, incomplete, evaded, or produced by a failed/outdated engine. Scan results therefore need engine/signature provenance and explicit states such as `pending`, `clean`, `suspicious`, `malicious`, `error`, and `skipped`; all results must retain `untrusted_content: true`. Password-protected files, nested archives, archive bombs, scanner timeouts, and type/extension mismatches must fail closed into quarantine rather than being treated as clean.

Cloudflare necessarily processes mail and retains Email Service event metadata according to its platform policy. Operators must disclose that boundary. Report vulnerabilities privately to the repository operator; do not include secrets or real message content in reports.
