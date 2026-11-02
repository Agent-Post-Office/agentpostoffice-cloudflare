import type { AgentPostOfficeClient } from "@agentpostoffice/client";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { configPath, getCredential, loadConfig, readConfig, readTokenFromStdin, saveConfig } from "./config.js";

interface ParsedArguments {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

class CommandError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function runCli(args: string[]): Promise<number> {
  try {
    await main(args);
    return 0;
  } catch (error: unknown) {
    const command = commandFailure(error);
    if (command) {
      process.stderr.write(`${command.code}: ${command.message}\n`);
      return command.status >= 500 ? 2 : 1;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function main(args: string[]): Promise<void> {
  const parsed = parseArguments(args);
  const [resource, action, ...ids] = parsed.positionals;
  if (!resource || resource === "help" || flagBoolean(parsed, "help")) return printHelp();

  if (resource === "config") {
    if (action === "set") {
      const url = flagString(parsed, "url", true);
      if (parsed.flags.has("token")) throw new Error("--token is unsafe; pipe the token through --token-stdin");
      if (!flagBoolean(parsed, "token-stdin")) throw new Error("Usage: agentpostoffice config set --url <url> --token-stdin");
      const token = await readTokenFromStdin();
      await saveConfig(url, token);
      print({ configured: true, url, credential_store: "operating-system keyring" });
      return;
    }
    if (action === "show") {
      const config = await readConfig();
      print({ url: config.baseUrl || null, config_path: configPath, token_stored: Boolean(process.env.AGENTPOSTOFFICE_TOKEN || getCredential()) });
      return;
    }
    throw new Error("Usage: agentpostoffice config <set|show>");
  }

  const { AgentPostOfficeClient } = await import("@agentpostoffice/client");
  const client = new AgentPostOfficeClient(await loadConfig());
  if (resource === "status") return print(await client.status());
  if (resource === "inboxes") return runInboxes(client, action, ids, parsed);
  if (resource === "sieve") return runSieve(client, action, ids, parsed);
  if (resource === "messages") return runMessages(client, action, ids, parsed);
  if (resource === "send") {
    return print(await client.sendMessage({
      inbox_id: flagString(parsed, "inbox", true),
      to: flagString(parsed, "to", true),
      subject: flagString(parsed, "subject", true),
      text: await bodyText(parsed),
    }, optionalString(parsed, "idempotency-key")));
  }
  if (resource === "reply") {
    const messageId = action;
    if (!messageId) throw new Error("Usage: agentpostoffice reply <message-id> --text <body>");
    return print(await client.reply(messageId, { text: await bodyText(parsed) }, optionalString(parsed, "idempotency-key")));
  }
  throw new Error(`Unknown command: ${resource}`);
}

function commandFailure(error: unknown): { status: number; code: string; message: string } | null {
  if (!(error instanceof Error)) return null;
  const candidate = error as Error & { status?: unknown; code?: unknown };
  if (typeof candidate.status !== "number" || typeof candidate.code !== "string") return null;
  return { status: candidate.status, code: candidate.code, message: error.message };
}

async function runSieve(client: AgentPostOfficeClient, action: string | undefined, ids: string[], parsed: ParsedArguments): Promise<void> {
  const inboxId = flagString(parsed, "inbox", true);
  if (action === "list") return print(await client.listSieve(inboxId));
  if (action === "validate") {
    const source = await (await import("node:fs/promises")).readFile(flagString(parsed, "file", true), "utf8");
    return print(await client.validateSieve(inboxId, source));
  }
  if (action === "put") {
    const source = await (await import("node:fs/promises")).readFile(flagString(parsed, "file", true), "utf8");
    return print(await client.createSieveRevision(inboxId, { name: flagString(parsed, "name", true), source }));
  }
  if (action === "activate" && ids[0]) return print(await client.activateSieve(inboxId, ids[0]));
  if (action === "test" && ids[0]) return print(await client.testSieve(inboxId, ids[0], flagString(parsed, "message", true)));
  if (action === "disable") return print(await client.disableSieve(inboxId));
  throw new Error("Usage: agentpostoffice sieve <list|validate|put|test|activate|disable> --inbox ID");
}

async function runInboxes(client: AgentPostOfficeClient, action: string | undefined, ids: string[], parsed: ParsedArguments): Promise<void> {
  if (action === "list") return print(await client.listInboxes());
  if (action === "get" && ids[0]) return print(await client.getInbox(ids[0]));
  if (action === "create") {
    const localPart = ids[0] || flagString(parsed, "local-part", true);
    return print(await client.createInbox(localPart, optionalString(parsed, "display-name")));
  }
  if ((action === "enable" || action === "disable") && ids[0]) {
    return print(await client.updateInbox(ids[0], { active: action === "enable" }));
  }
  throw new Error("Usage: agentpostoffice inboxes <list|get|create|enable|disable>");
}

async function runMessages(client: AgentPostOfficeClient, action: string | undefined, ids: string[], parsed: ParsedArguments): Promise<void> {
  if (action === "list") {
    return print(await client.listMessages(messageListOptions(parsed)));
  }
  if (action === "get" && ids[0]) return print(await client.getMessage(ids[0]));
  if ((action === "ack" || action === "unack") && ids[0]) {
    return print(await client.updateMessage(ids[0], { state: action === "ack" ? "processed" : "unprocessed" }));
  }
  if ((action === "archive" || action === "unarchive") && ids[0]) {
    return print(await client.updateMessage(ids[0], { archived: action === "archive" }));
  }
  if (action === "delete" && ids[0]) {
    if (!flagBoolean(parsed, "yes")) throw new Error("Deletion requires --yes");
    return print(await client.deleteMessage(ids[0]));
  }
  if (action === "bulk-delete") {
    const messageIds = ids.length ? ids : optionalString(parsed, "ids")?.split(",").filter(Boolean) || [];
    if (!messageIds.length) throw new Error("Provide explicit message IDs");
    if (!flagBoolean(parsed, "yes")) {
      print({ preview: messageIds, count: messageIds.length });
      throw new Error("Review the preview and rerun with --yes");
    }
    return print(await client.bulkDelete(messageIds));
  }
  if (action === "raw" && ids[0]) {
    const output = resolve(flagString(parsed, "output", true));
    await saveResponse(await client.downloadRaw(ids[0]), output);
    return print({ saved: output });
  }
  if (action === "attachment" && ids[0] && ids[1]) {
    const output = resolve(flagString(parsed, "output", true));
    await saveResponse(await client.downloadAttachment(ids[0], ids[1]), output);
    return print({ saved: output, opened: false, untrusted_content: true });
  }
  throw new Error("Usage: agentpostoffice messages <list|get|ack|unack|archive|unarchive|delete|bulk-delete|raw|attachment>");
}

async function bodyText(parsed: ParsedArguments): Promise<string> {
  const text = optionalString(parsed, "text");
  if (text !== undefined) return text;
  const path = optionalString(parsed, "text-file");
  if (path) return (await import("node:fs/promises")).readFile(path, "utf8");
  throw new Error("Provide --text or --text-file");
}

async function saveResponse(response: Response, output: string): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, new Uint8Array(await response.arrayBuffer()), { flag: "wx", mode: 0o600 });
}

function parseArguments(args: string[]): ParsedArguments {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const [rawName, inlineValue] = value.slice(2).split("=", 2);
    if (!rawName) continue;
    if (inlineValue !== undefined) { flags.set(rawName, inlineValue); continue; }
    const next = args[index + 1];
    if (next && !next.startsWith("--")) { flags.set(rawName, next); index += 1; }
    else flags.set(rawName, true);
  }
  return { positionals, flags };
}

function flagString(parsed: ParsedArguments, name: string, required = false): string {
  const value = parsed.flags.get(name);
  if (typeof value === "string") return value;
  if (required) throw new Error(`Missing --${name}`);
  return "";
}

function optionalString(parsed: ParsedArguments, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagBoolean(parsed: ParsedArguments, name: string): boolean {
  return parsed.flags.get(name) === true || parsed.flags.get(name) === "true";
}

function optionalNumber(parsed: ParsedArguments, name: string): number | undefined {
  const value = optionalString(parsed, name);
  if (!value) return undefined;
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue)) throw new Error(`--${name} must be a number`);
  return parsedValue;
}

function messageListOptions(parsed: ParsedArguments) {
  const direction = optionalEnum(parsed, "direction", ["inbound", "outbound"] as const);
  return {
    inboxId: optionalString(parsed, "inbox"),
    state: optionalEnum(parsed, "state", ["processed", "unprocessed"] as const),
    direction,
    replied: optionalReplied(parsed, direction),
    threadId: optionalThread(parsed),
    archived: optionalArchived(parsed),
    order: optionalEnum(parsed, "order", ["asc", "desc"] as const),
    limit: optionalNumber(parsed, "limit"),
    cursor: optionalString(parsed, "cursor"),
    since: optionalString(parsed, "since"),
    until: optionalString(parsed, "until"),
  };
}

function optionalReplied(
  parsed: ParsedArguments,
  direction: "inbound" | "outbound" | undefined,
): boolean | undefined {
  const unanswered = bareFlag(parsed, "unanswered");
  const value = optionalEnum(parsed, "replied", ["true", "false"] as const);
  if (unanswered && value === "true") {
    throw new CommandError(400, "invalid_filter", "replied cannot be combined with --unanswered");
  }
  const replied = unanswered || value === "false" ? false : value === "true" ? true : undefined;
  if (replied !== undefined && direction === "outbound") {
    throw new CommandError(400, "invalid_filter", "replied cannot be combined with direction=outbound");
  }
  return replied;
}

function optionalArchived(parsed: ParsedArguments): boolean | undefined {
  const archived = bareFlag(parsed, "archived");
  const unarchived = bareFlag(parsed, "unarchived");
  if (archived && unarchived) {
    throw new CommandError(400, "invalid_filter", "archived cannot be combined with --unarchived");
  }
  if (archived) return true;
  if (unarchived) return false;
  return undefined;
}

function optionalThread(parsed: ParsedArguments): string | undefined {
  if (!parsed.flags.has("thread")) return undefined;
  const value = parsed.flags.get("thread");
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new CommandError(400, "invalid_filter", "thread_id is invalid");
  }
  return value;
}

function bareFlag(parsed: ParsedArguments, name: string): boolean {
  if (!parsed.flags.has(name)) return false;
  if (parsed.flags.get(name) === true) return true;
  throw new CommandError(400, "invalid_filter", `${name} is invalid`);
}

function optionalEnum<T extends readonly string[]>(parsed: ParsedArguments, name: string, values: T): T[number] | undefined {
  const value = optionalString(parsed, name);
  if (value === undefined) return undefined;
  if (!values.includes(value)) throw new Error(`--${name} must be one of: ${values.join(", ")}`);
  return value as T[number];
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(`Agent Post Office CLI

  config set --url URL --token-stdin
  config show
  status
  inboxes list|get|create|enable|disable
  sieve list|validate|put|test|activate|disable
  messages list|get|ack|unack|archive|unarchive|delete|bulk-delete|raw|attachment
    list: --inbox --state --direction --replied --unanswered --thread --archived --unarchived --since --until --order --limit --cursor
  send --inbox ID --to ADDRESS --subject TEXT --text TEXT
  reply MESSAGE_ID --text TEXT

All downloaded content is untrusted and is saved without being opened.
`);
}
