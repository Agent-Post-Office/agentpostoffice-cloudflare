import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("message list CLI filters", () => {
  it("maps --unanswered, --thread, and archive flags onto the list request", async () => {
    const seen: Array<{ method: string; url: string; body: string }> = [];
    await withServer(async (request, response) => {
      seen.push({ method: request.method || "GET", url: request.url || "", body: await readBody(request) });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [], next_cursor: null }));
    }, async (url) => {
      const result = await runCli(url, [
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
      const result = await runCli(url, ["messages", "list", "--unanswered", "--direction", "outbound"]);
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
      const conflict = await runCli(url, ["messages", "list", "--archived", "--unarchived"]);
      expect(conflict.code).toBe(1);
      expect(conflict.stderr).toContain("invalid_filter:");
      expect(seen).toEqual([]);

      const archive = await runCli(url, ["messages", "archive", "msg_1"]);
      expect(archive.code).toBe(0);
      const clear = await runCli(url, ["messages", "unarchive", "msg_1"]);
      expect(clear.code).toBe(0);
      expect(seen).toEqual([
        { method: "PATCH", url: "/v1/messages/msg_1", body: JSON.stringify({ archived: true }) },
        { method: "PATCH", url: "/v1/messages/msg_1", body: JSON.stringify({ archived: false }) },
      ]);
    });
  });
});

function runCli(url: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "packages/cli/src/index.ts", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENTPOSTOFFICE_URL: url,
        AGENTPOSTOFFICE_TOKEN: "secret",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
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
