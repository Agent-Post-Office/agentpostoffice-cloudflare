# Security policy

Agent Post Office handles hostile email content and is currently a developer preview. Review [the complete security boundary](./docs/SECURITY.md) before deploying it.

## Report a vulnerability

Use GitHub's private vulnerability reporting for this repository: open the **Security** tab, choose **Advisories**, and select **Report a vulnerability**. Do not file a public issue for a suspected vulnerability.

Include the affected version or commit, impact, reproduction steps, and a minimal proof of concept. Never include production tokens, complete email addresses, real message content, attachments, or other people's data. Use generated identifiers and synthetic messages.

## Supported versions

Only the latest commit on `main` is currently supported. No release is production-ready until the mandatory Phase 0 matrix is complete.

## Current boundary

- All message fields, HTML, links, filenames, and attachments remain untrusted regardless of SPF, DKIM, DMARC, or a future malware-scan result.
- Raw messages and attachments stay in the operator's private Cloudflare R2 bucket and are exposed only as forced, non-sniffable, sandboxed downloads.
- The project does not currently provide malware scanning, spam filtering, guaranteed delivery, or exactly-once processing.
