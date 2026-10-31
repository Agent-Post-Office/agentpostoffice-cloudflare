import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { runCli } from "../packages/cli/src/index.js";

describe("message list CLI filters", () => {
  it("maps --unanswered, --thread, and archive flags onto the list request", async () => {
    const seen: Array<{ method: string; url: string; body: string }> = [];
    await withServer(async (request, response) => {
      seen.push({ method: request.method || "GET", url: request.url || "", body: await readBody(request) });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [], next_cursor: null }));
    }, async (url) => {
      const result = await invoke(url, [
        "messages", "list",
        "--unanswered",
        "--thread", "msg_thread_root",
        "--inbox", "inb_home",
        "--unarchived",
        "--state", "unprocessed",
        "--since", "2026-07-01T00:00:00.000Z",
        "--order", "asc",
      ]);
      expect(result.code).toBe(0);
      expect(seen).toHaveLength(1);
      const parsed = new URL(seen[0]!.url, url);
      expect(parsed.pathname).toBe("/v1/messages");
      expect(parsed.searchParams.get("replied")).toBe("false");
      expect(parsed.searchParams.get("direction")).toBeNull();
      expect(parsed.searchParams.get("thread_id")).toBe("msg_thread_root");
      expect(parsed.searchParams.get("inbox_id")).toBe("inb_home");
      expect(parsed.searchParams.get("archived")).toBe("false");
      expect(parsed.searchParams.get("state")).toBe("unprocessed");
      expect(parsed.searchParams.get("since")).toBe("2026-07-01T00:00:00.000Z");
      expect(parsed.searchParams.get("order")).toBe("asc");
    });
  });

  it("rejects --unanswered with outbound before calling the API", async () => {
    const seen: string[] = [];
    await withServer(async (request, response) => {
      seen.push(request.url || "");
      response.statusCode = 500;
      response.end("{}");
    }, async (url) => {
      const result = await invoke(url, ["messages", "list", "--unanswered", "--direction", "outbound"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("invalid_filter: replied cannot be combined with direction=outbound");
      expect(seen).toEqual([]);
    });
  });

  it("rejects conflicting archive flags and maps archive updates through messages PATCH", async () => {
    const seen: Array<{ method: string; url: string; body: string }> = [];
    await withServer(async (request, response) => {
      const body = await readBody(request);
      seen.push({ method: request.method || "GET", url: request.url || "", body });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: { id: "msg_1", archived_at: null } }));
    }, async (url) => {
      const conflict = await invoke(url, ["messages", "list", "--archived", "--unarchived"]);
      expect(conflict.code).toBe(1);
      expect(conflict.stderr).toContain("invalid_filter:");
      expect(seen).toEqual([]);

      const archive = await invoke(url, ["messages", "archive", "msg_1"]);
      expect(archive.code).toBe(0);
      const clear = await invoke(url, ["messages", "unarchive", "msg_1"]);
      expect(clear.code).toBe(0);
      expect(seen).toEqual([
        { method: "PATCH", url: "/v1/messages/msg_1", body: JSON.stringify({ archived: true }) },
        { method: "PATCH", url: "/v1/messages/msg_1", body: JSON.stringify({ archived: false }) },
      ]);
    });
  });
});

async function invoke(url: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const previousUrl = process.env.AGENTPOSTOFFICE_URL;
  const previousToken = process.env.AGENTPOSTOFFICE_TOKEN;
  process.env.AGENTPOSTOFFICE_URL = url;
  process.env.AGENTPOSTOFFICE_TOKEN = "secret";
  let stdout = "";
  let stderr = "";
  const writeOut = process.stdout.write;
  const writeErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await runCli(args);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
    if (previousUrl === undefined) delete process.env.AGENTPOSTOFFICE_URL;
    else process.env.AGENTPOSTOFFICE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.AGENTPOSTOFFICE_TOKEN;
    else process.env.AGENTPOSTOFFICE_TOKEN = previousToken;
  }
}

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "failed");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
