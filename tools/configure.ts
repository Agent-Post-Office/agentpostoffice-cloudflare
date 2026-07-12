import { spawn } from "node:child_process";
import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { findD1DatabaseId, resourceListContains, type D1ListEntry } from "./configure-helpers.js";

const flags = parseFlags(process.argv.slice(2));
const mailDomain = required("mail-domain").toLowerCase().replace(/\.$/, "");
const workerName = flags.get("worker-name") || "agentpostoffice";
const databaseName = flags.get("database-name") || "agentpostoffice";
const bucketName = flags.get("bucket-name") || "agentpostoffice-mail";
const queueName = flags.get("queue-name") || "agentpostoffice-mail";
const dlqName = flags.get("dlq-name") || "agentpostoffice-dlq";
const automationQueueName = flags.get("automation-queue-name") || "agentpostoffice-automation";
const automationDlqName = flags.get("automation-dlq-name") || "agentpostoffice-automation-dlq";
const output = resolve(flags.get("output") || "packages/worker/wrangler.jsonc");

await run(["wrangler", "whoami"]);
const databaseId = await ensureD1(databaseName);
await ensureResource("r2 bucket", bucketName, ["r2", "bucket", "list"], ["r2", "bucket", "create", bucketName]);
await ensureResource("queue", queueName, ["queues", "list"], ["queues", "create", queueName]);
await ensureResource("queue", dlqName, ["queues", "list"], ["queues", "create", dlqName]);
await ensureResource("queue", automationQueueName, ["queues", "list"], ["queues", "create", automationQueueName]);
await ensureResource("queue", automationDlqName, ["queues", "list"], ["queues", "create", automationDlqName]);

const configuration = {
  $schema: "../../node_modules/wrangler/config-schema.json",
  name: workerName,
  main: "src/index.ts",
  compatibility_date: "2026-07-10",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: true,
  observability: { enabled: true },
  vars: {
    MAIL_DOMAIN: mailDomain,
    MAX_INBOUND_BYTES: "10485760",
    BODY_EXCERPT_BYTES: "8192",
    DLQ_NAME: dlqName,
    AUTOMATION_DLQ_NAME: automationDlqName,
  },
  d1_databases: [{ binding: "DB", database_name: databaseName, database_id: databaseId, migrations_dir: "migrations" }],
  r2_buckets: [{ binding: "MAIL_BUCKET", bucket_name: bucketName }],
  queues: {
    producers: [
      { binding: "MAIL_QUEUE", queue: queueName },
      { binding: "AUTOMATION_QUEUE", queue: automationQueueName },
    ],
    consumers: [
      { queue: queueName, max_batch_size: 10, max_batch_timeout: 5, max_retries: 5, dead_letter_queue: dlqName },
      { queue: dlqName, max_batch_size: 10, max_batch_timeout: 5 },
      { queue: automationQueueName, max_batch_size: 10, max_batch_timeout: 5, max_retries: 3, dead_letter_queue: automationDlqName },
      { queue: automationDlqName, max_batch_size: 10, max_batch_timeout: 5 },
    ],
  },
  send_email: [{ name: "EMAIL" }],
};

try {
  await access(output);
  await copyFile(output, `${output}.bak`);
} catch {
  // First configuration has nothing to back up.
}
await writeFile(output, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`Wrote ${output}\n`);
await run(["wrangler", "d1", "migrations", "apply", databaseName, "--remote", "--config", output]);
process.stdout.write(`\nApplication resources are ready. Email Sending domain onboarding, DNS/MX changes, and the Email Routing catch-all remain Phase 0 live gates; review docs/PHASE-0.md before changing DNS.\n`);

async function ensureD1(name: string): Promise<string> {
  const before = JSON.parse(await run(["wrangler", "d1", "list", "--json"], true)) as D1ListEntry[];
  const existingId = findD1DatabaseId(before, name);
  if (existingId) return existingId;

  // Wrangler 4.110 supports JSON for list but not create. Create normally,
  // then re-list so the UUID comes from a stable machine-readable surface.
  await run(["wrangler", "d1", "create", name]);
  const after = JSON.parse(await run(["wrangler", "d1", "list", "--json"], true)) as D1ListEntry[];
  const createdId = findD1DatabaseId(after, name);
  if (!createdId) throw new Error("Wrangler created the D1 database but it was not found in the subsequent list");
  return createdId;
}

async function ensureResource(label: string, name: string, listArgs: string[], createArgs: string[]): Promise<void> {
  const outputText = await run(["wrangler", ...listArgs], true);
  if (resourceListContains(outputText, name)) return;
  process.stdout.write(`Creating ${label} ${name}\n`);
  await run(["wrangler", ...createArgs]);
}

async function run(args: string[], capture = false): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn("npx", args, { stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", shell: false });
    if (capture) child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolvePromise(Buffer.concat(chunks).toString("utf8"))
      : reject(new Error(`${args.join(" ")} exited with code ${code ?? "unknown"}`)));
  });
}

function required(name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function parseFlags(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value?.startsWith("--")) continue;
    const next = args[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}`);
    result.set(value.slice(2), next);
    index += 1;
  }
  return result;
}
