import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MCP_MAX_INLINE_ATTACHMENT_BYTES, sharedTools } from "../../mcp/src/catalog.js";
import { handleApi } from "../src/api.js";
import { MCP_MAX_REQUEST_BODY_BYTES } from "../src/mcp.js";
import type { Env, Scope } from "../src/types.js";
import { sha256Hex } from "../src/util.js";

const workerEnv = env as unknown as Env;
const readKeyId = "readkey123456";
const readToken = `apo_${readKeyId}_${"r".repeat(43)}`;
const fullKeyId = "fullkey123456";
const fullToken = `apo_${fullKeyId}_${"f".repeat(43)}`;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM idempotency_keys"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM inboxes"),
    env.DB.prepare("DELETE FROM api_keys"),
  ]);
});

describe("remote MCP over HTTPS", () => {
  it("keeps health unchanged and rejects non-POST /mcp without a session", async () => {
    const health = await handleApi(new Request("https://worker.example/health"), workerEnv);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, service: "agentpostoffice" });

    for (const method of ["GET", "DELETE", "PUT"]) {
      const response = await handleApi(new Request("https://worker.example/mcp", {
        method,
        headers: { Authorization: `Bearer ${readToken}` },
      }), workerEnv);
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("mcp-session-id")).toBeNull();
    }
  });

  it("returns 401 for a missing token and for a bad token", async () => {
    const logs: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logs.push(args); };
    try {
      const missing = await postMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams() });
      expect(missing.status).toBe(401);
      expect(missing.headers.get("www-authenticate")).toBe('Bearer realm="agentpostoffice"');
      expect(await missing.json()).toEqual({ error: { code: "unauthorized", message: "Invalid or expired bearer token" } });

      await insertKey(readKeyId, readToken, ["messages:read"]);
      const bad = await postMcp(
        { jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams() },
        `apo_${readKeyId}_${"x".repeat(43)}`,
      );
      expect(bad.status).toBe(401);
      expect(await bad.json()).toEqual({ error: { code: "unauthorized", message: "Invalid or expired bearer token" } });

      await env.DB.prepare("UPDATE api_keys SET revoked_at = '2020-01-01T00:00:00.000Z'").run();
      const revoked = await postMcp(
        { jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams() },
        readToken,
      );
      expect(revoked.status).toBe(401);
    } finally {
      console.error = original;
    }
    expect(JSON.stringify(logs)).not.toContain(readToken);
  });

  it("initializes and lists tools per scope", async () => {
    const seen = new Map<string, string[]>();
    for (const scope of [...new Set(sharedTools.map((tool) => tool.scope))]) {
      const keyId = `scope${scope.replace(/[^a-z]/g, "").slice(0, 12)}`;
      const token = `apo_${keyId}_${"s".repeat(43)}`;
      await insertKey(keyId, token, [scope]);
      const initialized = await rpc(token, "initialize", initializeParams());
      expect(initialized.result?.serverInfo).toEqual({ name: "agentpostoffice", version: "0.1.0" });
      expect(initialized.result?.protocolVersion).toBe("2025-11-25");
      const listed = await rpc(token, "tools/list", {});
      const names = (listed.result?.tools ?? []).map((tool) => tool.name).sort();
      expect(names).toEqual(sharedTools.filter((tool) => tool.scope === scope).map((tool) => tool.name).sort());
      seen.set(scope, names);
    }

    expect(seen.get("messages:read")).toEqual(expect.arrayContaining(["list_inboxes", "poll_messages", "get_message", "get_attachment"]));
    expect(seen.get("messages:read")).not.toEqual(expect.arrayContaining(["send_message", "delete_message", "save_raw_message", "save_attachment"]));
    expect(seen.get("messages:send")).toEqual(["send_message"]);
    expect(seen.get("messages:delete")).toEqual(["delete_message", "delete_messages"]);
  });

  it("runs a read tool in-process and labels the result untrusted", async () => {
    await insertKey(readKeyId, readToken, ["messages:read"]);
    await seedInbox();
    const listed = await rpc(readToken, "tools/list", {});
    expect(listed.result?.tools?.some((tool) => tool.name === "send_message")).toBe(false);

    const result = await rpc(readToken, "tools/call", { name: "list_inboxes", arguments: {} });
    expect(result.result?.isError).not.toBe(true);
    const payload = JSON.parse(result.result?.content?.[0]?.text ?? "") as { untrusted_content: boolean; data: Array<{ address: string }> };
    expect(payload.untrusted_content).toBe(true);
    expect(payload.data.map((inbox) => inbox.address)).toEqual(["research@mail.example.com"]);
    expect(result.headers.get("mcp-session-id")).toBeNull();
    expect(result.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns insufficient_scope for a write tool when the token is read-only", async () => {
    await insertKey(readKeyId, readToken, ["messages:read"]);
    await seedInbox();
    const result = await rpc(readToken, "tools/call", {
      name: "send_message",
      arguments: {
        inbox_id: "inb_test",
        to: "person@example.net",
        subject: "Hello",
        text: "Body",
        idempotency_key: "read-token-send",
      },
    });
    expect(result.status).toBe(200);
    expect(result.result?.isError).toBe(true);
    expect(JSON.parse(result.result?.content?.[0]?.text ?? "")).toEqual({
      error: { code: "insufficient_scope", message: "Token does not have the required scope" },
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM messages").first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("refuses an oversized POST and an oversized or unchecked attachment", async () => {
    await insertKey(fullKeyId, fullToken, ["messages:read", "messages:delete"]);
    await seedInbox();
    await seedMessage("msg_1");
    const bytes = "hello attachment";
    const checksum = await sha256Hex(bytes);
    await env.DB.prepare(
      `INSERT INTO attachments
       (id, message_id, r2_key, filename, media_type, disposition, size, checksum_sha256, created_at)
       VALUES ('att_ok', 'msg_1', 'attachments/att_ok', 'note.txt', 'text/plain', 'attachment', ?, ?, ?)`,
    ).bind(bytes.length, checksum, "2026-07-10T00:00:00.000Z").run();
    await env.MAIL_BUCKET.put("attachments/att_ok", bytes);

    const inline = await rpc(fullToken, "tools/call", {
      name: "get_attachment",
      arguments: { message_id: "msg_1", attachment_id: "att_ok", acknowledge_untrusted_bytes: true },
    });
    expect(inline.result?.isError).not.toBe(true);
    const inlinePayload = JSON.parse(inline.result?.content?.[0]?.text ?? "") as {
      untrusted_content: boolean;
      data: { data_base64: string; checksum_sha256: string };
    };
    expect(inlinePayload.untrusted_content).toBe(true);
    expect(inlinePayload.data.checksum_sha256).toBe(checksum);
    expect(atob(inlinePayload.data.data_base64)).toBe(bytes);

    await env.DB.prepare(
      `INSERT INTO attachments
       (id, message_id, r2_key, filename, media_type, disposition, size, checksum_sha256, created_at)
       VALUES ('att_bad', 'msg_1', 'attachments/att_bad', 'bad.txt', 'text/plain', 'attachment', 4, ?, ?)`,
    ).bind("a".repeat(64), "2026-07-10T00:00:00.000Z").run();
    await env.MAIL_BUCKET.put("attachments/att_bad", "bbbb");
    const mismatch = await rpc(fullToken, "tools/call", {
      name: "get_attachment",
      arguments: { message_id: "msg_1", attachment_id: "att_bad", acknowledge_untrusted_bytes: true },
    });
    expect(mismatch.result?.isError).toBe(true);
    expect(mismatch.result?.content?.[0]?.text).not.toContain("YmJiYg");

    await env.DB.prepare(
      `INSERT INTO attachments
       (id, message_id, r2_key, filename, media_type, disposition, size, checksum_sha256, created_at)
       VALUES ('att_big', 'msg_1', 'attachments/att_big', 'big.bin', 'application/octet-stream', 'attachment', ?, ?, ?)`,
    ).bind(MCP_MAX_INLINE_ATTACHMENT_BYTES + 1, "b".repeat(64), "2026-07-10T00:00:00.000Z").run();
    const oversizedAttachment = await rpc(fullToken, "tools/call", {
      name: "get_attachment",
      arguments: { message_id: "msg_1", attachment_id: "att_big", acknowledge_untrusted_bytes: true },
    });
    expect(oversizedAttachment.result?.isError).toBe(true);
    expect(JSON.parse(oversizedAttachment.result?.content?.[0]?.text ?? "").error.code).toBe("attachment_too_large");

    const deleted = await rpc(fullToken, "tools/call", {
      name: "delete_message",
      arguments: { message_id: "msg_1" },
    });
    expect(deleted.result?.isError === true || deleted.error).toBeTruthy();
    const row = await env.DB.prepare("SELECT tombstoned_at FROM messages WHERE id = 'msg_1'").first<{ tombstoned_at: string | null }>();
    expect(row?.tombstoned_at).toBeNull();

    const huge = await handleApi(new Request("https://worker.example/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullToken}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: "x".repeat(MCP_MAX_REQUEST_BODY_BYTES + 1),
    }), workerEnv);
    expect(huge.status).toBe(413);
  });

  it("lists the full HTTP tool set for a token that holds every scope", async () => {
    await insertKey(fullKeyId, fullToken, sharedTools.map((tool) => tool.scope).filter((scope, index, all) => all.indexOf(scope) === index));
    const listed = await rpc(fullToken, "tools/list", {});
    expect((listed.result?.tools ?? []).map((tool) => tool.name).sort()).toEqual(sharedTools.map((tool) => tool.name).sort());
  });
});

function initializeParams(): Record<string, unknown> {
  return {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  };
}

async function insertKey(keyId: string, token: string, scopes: Scope[]): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO api_keys (key_id, digest_sha256, label, scopes_json, created_at) VALUES (?, ?, 'mcp', ?, ?)",
  ).bind(keyId, await sha256Hex(token), JSON.stringify(scopes), "2026-07-10T00:00:00.000Z").run();
}

async function seedInbox(): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO inboxes (id, domain, local_part, active, created_at, updated_at) VALUES ('inb_test', 'mail.example.com', 'research', 1, ?, ?)",
  ).bind("2026-07-10T00:00:00.000Z", "2026-07-10T00:00:00.000Z").run();
}

async function seedMessage(id: string): Promise<void> {
  const receivedAt = "2026-07-10T10:00:00.000Z";
  await env.DB.prepare(
    `INSERT INTO messages
     (id, inbox_id, direction, envelope_from, envelope_to, subject, text_excerpt, parse_status, agent_state, labels_json, headers_json, received_at, created_at, updated_at)
     VALUES (?, 'inb_test', 'inbound', 'person@example.net', 'research@mail.example.com', 'Question', 'Body', 'ready', 'unprocessed', '[]', '{}', ?, ?, ?)`,
  ).bind(id, receivedAt, receivedAt, receivedAt).run();
}

interface ToolSummary { name: string }
interface RpcBody {
  result?: {
    protocolVersion?: string;
    serverInfo?: { name: string; version: string };
    tools?: ToolSummary[];
    content?: Array<{ text: string }>;
    isError?: boolean;
  };
  error?: { message: string };
}

async function rpc(token: string, method: string, params: Record<string, unknown>): Promise<RpcBody & { status: number; headers: Headers }> {
  const response = await postMcp({ jsonrpc: "2.0", id: 1, method, params }, token);
  const body = await response.json() as RpcBody;
  return { ...body, status: response.status, headers: response.headers };
}

function postMcp(body: unknown, token?: string): Promise<Response> {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return handleApi(new Request("https://worker.example/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }), workerEnv);
}
