# Agent Post Office installation

## Minimum working setup

Use Node.js 20+ and npm, a domain on Cloudflare DNS, and a Cloudflare account with Workers Paid and Email Sending eligibility. Use your existing Wrangler login (`npx wrangler whoami`); run `npx wrangler login` if needed. A suitable scoped API token is also supported. Keep credentials out of chat and source files.

1. **Deploy one domain and create active inboxes.** Clone the repository and run these commands from its root, replacing `example.com` with the exact mail domain:

   ```bash
   git clone https://github.com/Agent-Post-Office/agentpostoffice-cloudflare.git
   cd agentpostoffice-cloudflare
   npm install
   npm test
   npm run check
   npm run build
   npm run config:generate -- --mail-domain example.com
   npm run deploy
   npm --workspace @agentpostoffice/worker run migrate:remote
   ```

   Review the generated Worker, account, bindings, and `MAIL_DOMAIN` before deployment. Each deployment serves one mail domain. Configure the CLI with an existing valid APO credential, or follow the [first-token procedure](./INSTALL-REFERENCE.md#5-deploy-migrate-and-create-an-application-token) if none exists. Then create and confirm your intended inboxes:

   ```bash
   node packages/cli/dist/index.js status
   node packages/cli/dist/index.js inboxes create research --display-name "Research Agent"
   node packages/cli/dist/index.js inboxes list
   ```

2. **Back up DNS before the mail cutover.** Inventory existing mail consumers and export DNS for rollback. Review Cloudflare's generated routing records for the exact domain. Replace obsolete prior-provider MX/SPF with those records while preserving unrelated DNS, verification TXT, and needed DKIM/DMARC. Keep one SPF record per hostname; see the [migration checklist](./INSTALL-REFERENCE.md#custom-domain-migration-checklist) for shared senders.
3. **Activate Email Routing and save the route.** In Cloudflare Email Routing, activate the domain, then configure **one Catch-all → Send to a Worker** rule targeting the matching APO Worker. **Save and enable** it, and reopen it to verify both. Confirm public MX and any exact-recipient overrides. No separate Cloudflare rule per mailbox is needed: future active APO inboxes use the same catch-all. The Worker rejects unknown or disabled addresses.
4. **Configure outbound sending separately.** Onboard the exact domain in Cloudflare Email Sending, review its generated authentication and bounce records, and wait for readiness. Sending setup does not activate inbound routing. See the [dashboard steps](./INSTALL-REFERENCE.md#path-a---manual-dashboard) or [agent-assisted commands](./INSTALL-REFERENCE.md#path-b---agent-assisted-wrangler).
5. **Prove delivery both ways.** Send a disposable message from an external test address to `research@example.com` and confirm it appears in APO. Reply from APO and confirm the external mailbox actually receives it, checking spam and authentication headers. Outbound success, `/health`, active app inboxes, and working website DNS do not prove inbound readiness. After a permanent `550`/`554` bounce, the sender must manually resend once the fix and a fresh inbound test succeed.

   ```bash
   node packages/cli/dist/index.js messages list --direction inbound --state unprocessed
   node packages/cli/dist/index.js messages get <message-id>
   node packages/cli/dist/index.js messages ack <message-id>
   node packages/cli/dist/index.js reply <message-id> --text "Installation test reply"
   ```

For agent-assisted installation, ask your agent to follow the repository's `agentpostoffice-setup` skill using your existing login, exact domain, and intended inboxes. Review proposed live changes before authorizing deployment, DNS/MX changes, routing, sending onboarding, or real test mail. Never paste tokens into chat.

See the [installation reference](./INSTALL-REFERENCE.md) for credential permissions, token administration, migration, troubleshooting, and optional MCP configuration. Working delivery does not complete the full developer-preview [Phase 0 proof matrix](./PHASE-0.md).
