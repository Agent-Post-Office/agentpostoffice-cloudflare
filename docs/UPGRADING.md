# Upgrade existing deployments

Merging to this repository runs CI; it does not deploy self-hosted Workers. Use one ignored Wrangler configuration per existing instance and deploy serially with explicit operator approval.

Keep an ignored local registry (for example `.agentpostoffice/deployments.json`) with each instance’s alias, config path, Worker name, mail domain, Worker URL, database name, and verified deployed commit/version. Store no credentials or mail data in it.

Before upgrading, compare the deployed version and runtime with the proposed release. Preserve existing API routes, supported token scopes, queue task kinds, schema, scripts, and bindings. An unmerged feature branch may already be running in production; do not replace it with a main tree that lacks those features.

Run `npm ci`, `npm test`, `npm run check`, and `npm run build` before deployment. Confirm the canonical OpenAPI includes every route and regenerate its JSON artifact when it changes. Inspect migrations and declare the release's schema mode: none, additive expansion, or destructive contraction. A Worker rollback does not roll back the database.

For each selected instance:

1. Verify the existing Wrangler account, Worker name, domain, deployment version, and named configuration.
2. Compare live D1/R2/Email bindings, variables, compatibility settings, queue producers and consumers with that configuration. Reuse the existing resources. Record the prior version for rollback.
3. Inspect applied migrations and existing schema. Skip migration application when the deployed schema already matches the release. Do not activate or modify scripts during an upgrade.
4. Run `wrangler deploy --dry-run --config <instance-config>`, inspect the compiled bindings, then deploy the reviewed release with the same config and a message containing its exact Git commit.
5. Verify the deployed version, public discovery/spec/health, protected authentication, and read-only inbox/Sieve access with that domain's existing credential kept in memory. Compare script revision/hash/activation metadata and queue settings with the baseline.
6. Continue to the next instance only after verification passes. Stop on a material mismatch. Revert to the recorded prior Worker version if necessary, preserving database and queue resources.

Upgrade checks do not authorize sending mail, activating new automation, deleting data, changing keys, or provisioning resources. Existing configured automation continues to operate normally.
