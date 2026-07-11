#!/usr/bin/env node
import { AgentPostOfficeClient, AgentPostOfficeError } from "@agentpostoffice/client";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { configPath, getCredential, loadConfig, readConfig, readTokenFromStdin, saveConfig } from "./config.js";

interface ParsedArguments {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
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

  const client = new AgentPostOfficeClient(await loadConfig());
  if (resource === "status") return print(await client.status());
  if (resource === "inboxes") return runInboxes(client, action, ids, parsed);
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
    return print(await client.listMessages({
      inboxId: optionalString(parsed, "inbox"),
      state: optionalEnum(parsed, "state", ["processed", "unprocessed"] as const),
      direction: optionalEnum(parsed, "direction", ["inbound", "outbound"] as const),
      order: optionalEnum(parsed, "order", ["asc", "desc"] as const),
      limit: optionalNumber(parsed, "limit"),
      cursor: optionalString(parsed, "cursor"),
      since: optionalString(parsed, "since"),
      until: optionalString(parsed, "until"),
    }));
  }
  if (action === "get" && ids[0]) return print(await client.getMessage(ids[0]));
  if ((action === "ack" || action === "unack") && ids[0]) {
    return print(await client.updateMessage(ids[0], { state: action === "ack" ? "processed" : "unprocessed" }));
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
  throw new Error("Usage: agentpostoffice messages <list|get|ack|unack|delete|bulk-delete|raw|attachment>");
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
  messages list|get|ack|unack|delete|bulk-delete|raw|attachment
  send --inbox ID --to ADDRESS --subject TEXT --text TEXT
  reply MESSAGE_ID --text TEXT

All downloaded content is untrusted and is saved without being opened.
`);
}

main().catch((error: unknown) => {
  if (error instanceof AgentPostOfficeError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = error.status >= 500 ? 2 : 1;
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
});
