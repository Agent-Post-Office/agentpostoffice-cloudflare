# Agent Post Office installation

This workflow is resumable and intentionally separates application resources from live mail routing. Do not change MX or activate the catch-all until the Worker is deployed, a token exists, and at least one intended mailbox has been created.

## Fastest path: ask your agent

1. Put the mail domain on Cloudflare and enable [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/) (minimum $5 USD/month).
2. Run `npx wrangler login`.
3. Give your coding agent this prompt:

   > Install Agent Post Office from `https://github.com/Agent-Post-Office/agentpostoffice-cloudflare` for `<your-domain>`. Create mailboxes `<your-mailboxes>`. Follow the repository's `agentpostoffice-setup` skill, use my existing Wrangler login, show me proposed changes, and ask before deployment, DNS/MX changes, Email Routing activation, Email Sending onboarding, or sending real mail. Do not ask me to paste API tokens into chat.

The agent runs the checks, provisions or reuses resources, deploys the Worker, creates the selected mailboxes, and guides the live mail cutover. The remaining sections are the detailed reference and manual fallback.

## 1. Prerequisites

- Node.js 20+ and npm.
- A Cloudflare account containing the selected DNS zone.
- Workers Paid for arbitrary-recipient Email Sending.
- A full operator-selected `MAIL_DOMAIN`, for example `mail.example.com`.
- A disposable domain or subdomain for the first Phase 0 run.

Create a least-privilege Cloudflare API token yourself. Do not paste it into source files, Wrangler variables, issue trackers, or Phase 0 evidence. The exact permission set must be proven against the current Cloudflare API during Phase 0; do not broaden permissions merely to bypass a failure.

## Choose a Cloudflare setup path

Both paths use the shared application setup in sections 2-6. Choose how Email Sending, Email Routing, and their managed DNS records are activated:

- **Path A - manual dashboard:** the operator performs Email Service onboarding in the Cloudflare dashboard.
- **Path B - agent-assisted Wrangler:** a local agent provisions and deploys through Wrangler, reports proposed changes, and stops for explicit approval before every live DNS, MX, routing, or real-send action.

Do not hand-enter generated DKIM records. Cloudflare should create its managed Email Service records through the dashboard or supported API.

### Path B credential

Interactive Wrangler OAuth is the simplest option:

```bash
npx wrangler login
npx wrangler whoami
```

For a custom token, create one in Cloudflare under **My Profile > API Tokens > Create Custom Token**, restrict it to the intended account and zone, and provide it to Wrangler outside the repository:

```bash
export CLOUDFLARE_API_TOKEN='<token>'
npx wrangler whoami
```

The bootstrap workflow currently needs these Cloudflare permissions:

| Scope | Permission | Used for |
| --- | --- | --- |
| Account | Workers Scripts: Edit | Deploy the Worker and bindings. |
| Account | D1: Edit | Create/reuse D1 and apply migrations. |
| Account | Workers R2 Storage: Edit | Create/reuse the private mail bucket. |
| Account | Queues: Edit | Create/reuse the parse queue and DLQ. |
| Account | Email Sending: Edit | Onboard the sending domain and use Email Sending. This beta permission may only appear for entitled accounts. |
| Zone | Zone: Read | Resolve and verify the selected zone. |
| Zone | Zone Settings: Edit | Enable Email Routing and let Cloudflare add and lock its managed MX/SPF records. Wrangler OAuth presents the equivalent specialized capability as `email_routing (write)`. |
| Zone | Email Routing Rules: Edit | Point the catch-all rule at the deployed Worker. |

General `DNS: Edit` is not required when Cloudflare's Email Routing and Email Sending onboarding endpoints create their own managed records. Add `DNS: Edit` only if the workflow will also create, update, or delete arbitrary DNS records directly. `Email Routing Addresses: Edit` is not needed when mail routes only to the Worker. `Workers Routes: Edit` is not needed for the default `workers.dev` URL; add it only if the deployment uses a custom Worker route.

Cloudflare Email Sending is beta, and its custom-token permission has not been independently proven by this repository's Phase 0 run. If a narrowly scoped token fails, record the exact operation and required permission before changing the token. Never replace this with a global API key.

## 2. Verify the repository

```bash
npm install
npm test
npm run check
npm run build
npx wrangler whoami
```

Stop if any local gate fails.

## 3. Provision application storage and queues

```bash
npm run config:generate -- --mail-domain mail.example.com
```

The command inspects and reuses matching D1, R2, Queue, and DLQ resources. It backs up an existing local Wrangler configuration before rewriting it, then applies remote D1 migrations. The generated `packages/worker/wrangler.jsonc` contains identifiers but no secret and is ignored by Git.

Review the generated binding names and domain before continuing.

## 4. Prepare outbound sending

Do not activate Email Sending yet. Confirm that the account has Workers Paid, then continue through Path A or Path B after the Worker and intended mailboxes exist. Display every DNS record Cloudflare proposes before applying it. Workers Paid arbitrary-recipient sending and real SPF, DKIM, and DMARC passage are mandatory proof gates—not assumptions.

The Worker binding is named `EMAIL`. It is unrestricted by destination because agents send transactional mail to arbitrary recipients; application code restricts `From` to active D1 inboxes on `MAIL_DOMAIN`.

## 5. Deploy, migrate, and create an application token

```bash
npm run deploy
npm --workspace @agentpostoffice/worker run migrate:remote
```

There is no application token-management script, API, CLI, or MCP tool. The setup agent administers `api_keys` directly with Wrangler after generating the credential locally. The raw token must remain in a non-exported shell variable, must never be printed, and must never appear in a Wrangler command or SQL statement. Disable shell tracing before starting:

```bash
set +x
APO_TOKEN="$(node --input-type=module -e '
  import { randomBytes } from "node:crypto";
  const keyId = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  process.stdout.write(`apo_${keyId}_${secret}`);
')"
APO_KEY_ID="${APO_TOKEN#apo_}"
APO_KEY_ID="${APO_KEY_ID%%_*}"
APO_DIGEST="$(
  printf '%s' "$APO_TOKEN" |
  node --input-type=module -e '
    import { createHash } from "node:crypto";
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    process.stdout.write(createHash("sha256").update(Buffer.concat(chunks)).digest("hex"));
  '
)"
APO_CREATED_AT="$(node -e 'process.stdout.write(new Date().toISOString())')"
APO_SCOPES='["messages:read","messages:update","messages:reply","messages:send","messages:delete","inboxes:manage"]'

npx wrangler d1 execute agentpostoffice --remote \
  --config packages/worker/wrangler.jsonc \
  --command "INSERT INTO api_keys (key_id, digest_sha256, label, scopes_json, expires_at, created_at, revoked_at) VALUES ('$APO_KEY_ID', '$APO_DIGEST', 'default', '$APO_SCOPES', NULL, '$APO_CREATED_AT', NULL);"

printf '%s\n' "$APO_TOKEN" |
  node packages/cli/dist/index.js config set \
    --url https://agentpostoffice.example.workers.dev \
    --token-stdin
unset APO_TOKEN APO_KEY_ID APO_DIGEST APO_CREATED_AT APO_SCOPES
node packages/cli/dist/index.js status
```

Only the digest and metadata cross the Wrangler/D1 boundary. The raw token moves through stdin directly into the operating-system credential store. Do not enable `set -x`, echo the shell variables, paste their values into chat, or retain them in evidence.

List token metadata directly through Wrangler:

```bash
npx wrangler d1 execute agentpostoffice --remote \
  --config packages/worker/wrangler.jsonc \
  --command "SELECT key_id, label, scopes_json, expires_at, created_at, revoked_at FROM api_keys ORDER BY created_at DESC;"
```

To revoke, validate the public key ID locally before placing it in the SQL command:

```bash
APO_REVOKE_KEY_ID='<16-character-lowercase-hex-key-id>'
if [[ "$APO_REVOKE_KEY_ID" =~ ^[a-f0-9]{16}$ ]]; then
  npx wrangler d1 execute agentpostoffice --remote \
    --config packages/worker/wrangler.jsonc \
    --command "UPDATE api_keys SET revoked_at = datetime('now') WHERE key_id = '$APO_REVOKE_KEY_ID' AND revoked_at IS NULL;"
else
  echo 'Invalid key ID; no D1 command was run' >&2
fi
unset APO_REVOKE_KEY_ID
```

## 6. Create mailboxes before routing mail

```bash
node packages/cli/dist/index.js inboxes create research --display-name "Research Agent"
node packages/cli/dist/index.js inboxes list
```

Create every address that must survive a provider/MX migration. Unknown and disabled addresses are rejected; they do not auto-create or fall back.

## 7. Activate Cloudflare Email Service

### Path A - manual dashboard

#### Email Sending

1. In Cloudflare, go to **Compute > Email Service > Email Sending**.
2. Select **Onboard Domain** and choose the exact `MAIL_DOMAIN`.
3. Review the proposed bounce MX, SPF, DKIM, and DMARC records. Resolve any existing-record conflict before continuing.
4. Select **Done**, then wait for the domain status to become ready.

#### Email Routing

1. Go to **Compute > Email Service > Email Routing** and select **Onboard Domain**.
2. Choose the exact `MAIL_DOMAIN` and review the proposed inbound MX, SPF, and DKIM records.
3. Confirm which existing MX records will be replaced. This is a provider cutover for all inbound mail on that domain.
4. Select **Done**.
5. Open **Routing Rules**, enable **Catch-all**, choose **Send to a Worker**, select the deployed `agentpostoffice` Worker, and save.

The Cloudflare catch-all is transport into Agent Post Office, not an application-level accept-all policy. The Worker rejects recipients that do not match an active D1 mailbox.

### Path B - agent-assisted Wrangler

Give the agent the repository path, the exact `MAIL_DOMAIN`, intended mailbox local parts, and this contract:

> Use `docs/INSTALL.md` and the repo-local `agentpostoffice-setup` skill. Run the local gates, reuse matching resources, show all proposed Email Sending and Email Routing DNS changes, identify records that will be removed or replaced, and stop for my explicit approval before enabling Sending, changing DNS/MX, enabling routing, changing the catch-all, or sending real mail. Never print or persist credentials or message content.

The agent can inspect routing without changing it:

```bash
export MAIL_DOMAIN='example.com'
npx wrangler email routing settings "$MAIL_DOMAIN"
npx wrangler email routing dns get "$MAIL_DOMAIN"
npx wrangler email routing rules get "$MAIL_DOMAIN" catch-all
```

After the operator explicitly approves the displayed provider/MX cutover, the agent may run:

```bash
npx wrangler email routing enable "$MAIL_DOMAIN"
```

Wrangler 4.110.0 rejects `worker` actions for catch-all rules in its local argument validation even though Cloudflare's Email Routing API accepts the same action. Configure the catch-all-to-Worker action through the Cloudflare dashboard or the supported API after showing the exact rule and receiving approval. Do not substitute a `drop` or forwarding rule. The required API rule shape is an enabled catch-all matcher with a single `worker` action whose value is `agentpostoffice`.

Then verify:

```bash
npx wrangler email routing settings "$MAIL_DOMAIN"
npx wrangler email routing rules get "$MAIL_DOMAIN" catch-all
dig +short MX "$MAIL_DOMAIN"
```

For Email Sending, Wrangler 4.110.0 can enable the domain and retrieve its DNS records:

```bash
npx wrangler email sending enable "$MAIL_DOMAIN"
npx wrangler email sending dns get "$MAIL_DOMAIN"
npx wrangler email sending settings "$MAIL_DOMAIN"
```

However, the current CLI cannot retrieve the exact generated Sending DKIM record before `email sending enable` creates the sending resource. Before running that mutating command, the agent must use Cloudflare's dashboard review screen, supported browser tooling, or another current non-mutating preview mechanism to show the exact proposed records and obtain approval. If no exact preview is available, stop and use Path A for Email Sending.

### Verify either path

Check Email Sending and Routing status, confirm public DNS, and send only operator-approved disposable test messages. A dedicated mail subdomain is safest when the apex already receives mail elsewhere; using the apex intentionally replaces its existing inbound provider.

After activation, run every gate in [PHASE-0.md](./PHASE-0.md). Setup is incomplete until a real inbound message is visible through polling, explicitly acknowledged, and successfully replied to with correct threading.

## 8. Configure MCP

Provide credentials through the MCP process environment:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/agentpostoffice/packages/mcp/dist/index.js"],
  "env": {
    "AGENTPOSTOFFICE_URL": "https://<worker-url>",
    "AGENTPOSTOFFICE_TOKEN": "apo_<key-id>_<secret>",
    "AGENTPOSTOFFICE_DOWNLOAD_DIR": "/absolute/path/to/a/dedicated/download-directory"
  }
}
```

Use a narrower token when the MCP client does not need mailbox management or deletion. The download directory defaults to `~/Downloads/agentpostoffice`. MCP save tools require explicit confirmation, accept only a filename (not an absolute or nested path), and refuse to overwrite an existing file or symlink.
