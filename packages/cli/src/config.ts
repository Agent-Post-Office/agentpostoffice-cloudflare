import { Entry } from "@napi-rs/keyring";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SERVICE = "agentpostoffice";
const ACCOUNT = "default";

export interface LocalConfig {
  baseUrl: string;
}

export const configPath = process.env.AGENTPOSTOFFICE_CONFIG || join(homedir(), ".config", "agentpostoffice", "config.json");

export async function loadConfig(): Promise<{ baseUrl: string; token: string }> {
  const baseUrl = process.env.AGENTPOSTOFFICE_URL || (await readConfig()).baseUrl;
  const token = process.env.AGENTPOSTOFFICE_TOKEN || getCredential();
  if (!baseUrl || !token) throw new Error("Agent Post Office is not configured. Run: agentpostoffice config set --url <url> --token-stdin");
  return { baseUrl, token };
}

export async function readTokenFromStdin(
  input: AsyncIterable<string | Buffer> = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 4_096) throw new Error("Token input is invalid or too large");
    chunks.push(bytes);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const token = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!/^apo_[a-zA-Z0-9-]{6,64}_[A-Za-z0-9_-]{40,64}$/.test(token)) {
    throw new Error("Token input must contain exactly one valid Agent Post Office token");
  }
  return token;
}

export async function saveConfig(baseUrl: string, token: string): Promise<void> {
  const normalizedUrl = new URL(baseUrl).toString().replace(/\/$/, "");
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ baseUrl: normalizedUrl }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, configPath);
  const entry = new Entry(SERVICE, ACCOUNT);
  entry.setPassword(token);
}

export async function readConfig(): Promise<LocalConfig> {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as Partial<LocalConfig>;
    return { baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "" };
  } catch {
    return { baseUrl: "" };
  }
}

export function getCredential(): string {
  try {
    return new Entry(SERVICE, ACCOUNT).getPassword() || "";
  } catch {
    return "";
  }
}
