import openapi from "../src/openapi.generated.json" with { type: "json" };
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleApi } from "../src/api.js";
import type { Env } from "../src/types.js";
import { sha256Hex } from "../src/util.js";

const token = `apo_abcdef1234567890_${"A".repeat(43)}`;
const workerEnv = env as unknown as Env;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM idempotency_keys"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM inboxes"),
    env.DB.prepare("DELETE FROM api_keys"),
  ]);
  await env.DB.prepare(
    "INSERT INTO api_keys (key_id, digest_sha256, label, scopes_json, created_at) VALUES (?, ?, 'test', ?, ?)",
  ).bind(
    "abcdef1234567890",
    await sha256Hex(token),
    JSON.stringify(["messages:read", "messages:update", "messages:reply", "messages:send", "messages:delete", "inboxes:manage"]),
    "2026-07-10T00:00:00.000Z",
  ).run();
});

describe("REST API contract", () => {
  it("exposes only generic public discovery and the canonical JSON spec", async () => {
    const response = await handleApi(new Request("https://worker.example/"), {} as Env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: "agentpostoffice",
      description: "Self-hosted email API for transactional messages and threaded replies.",
      links: { openapi: "/openapi.json", docs: "https://github.com/Agent-Post-Office/agentpostoffice-cloudflare#basic-api-use" },
    });
    const specResponse = await handleApi(new Request("https://worker.example/openapi.json"), {} as Env);
    expect(specResponse.status).toBe(200);
    const spec = await specResponse.json() as { openapi: string; paths: Record<string, unknown> };
    expect(spec).toEqual(openapi);
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths).toHaveProperty("/messages");
    expect(spec.paths).toHaveProperty("/messages/{message_id}/reply");
    for (const path of ["/", "/openapi.json"]) {
      expect((await handleApi(new Request(`https://worker.example${path}`, { method: "POST" }), {} as Env)).status).toBe(404);
    }
  });

  it("keeps send and reply protected with distinct authentication and scope failures", async () => {
    for (const path of ["/v1/messages", "/v1/messages/msg_missing/reply"]) {
      const response = await handleApi(new Request(`https://worker.example${path}`, { method: "POST" }), workerEnv);
      expect(response.status).toBe(401);
    }
    await env.DB.prepare("UPDATE api_keys SET scopes_json = ?").bind('["messages:read"]').run();
    for (const path of ["/v1/messages", "/v1/messages/msg_missing/reply"]) {
      const response = await api(path, { method: "POST", body: "{}" });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { code: "insufficient_scope", message: "Token does not have the required scope" } });
    }
  });

  it("protects every documented mail operation from absent credentials and scopes", async () => {
    await seedInbox();
    await env.DB.prepare("UPDATE api_keys SET scopes_json = '[]'").run();
    for (const [path, item] of Object.entries(openapi.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!["get", "post", "patch", "delete"].includes(method) || !("x-required-scopes" in operation)) continue;
        const route = `/v1${path.replace("{inbox_id}", "inb_test").replace(/\{[^}]+\}/g, "placeholder")}`;
        expect((await handleApi(new Request(`https://worker.example${route}`, { method: method.toUpperCase() }), workerEnv)).status, `${method} ${route}`).toBe(401);
        expect((await api(route, { method: method.toUpperCase() })).status, `${method} ${route}`).toBe(403);
      }
    }
  });

  it("keeps invalid, expired and revoked keys unauthorized after public discovery", async () => {
    for (const changes of ["expires_at = '2000-01-01T00:00:00Z'", "expires_at = NULL, revoked_at = '2020-01-01T00:00:00Z'"]) {
      await env.DB.prepare(`UPDATE api_keys SET ${changes}`).run();
      expect((await api("/v1/messages")).status).toBe(401);
      expect((await handleApi(new Request("https://worker.example/openapi.json", { headers: { Authorization: `Bearer ${token}` } }), workerEnv)).status).toBe(200);
    }
    expect((await handleApi(new Request("https://worker.example/v1/messages", { headers: { Authorization: "Bearer invalid" } }), workerEnv)).status).toBe(401);
  });

  it("rejects tokens in URLs and returns a constant-shaped bearer challenge", async () => {
    const response = await handleApi(new Request(`https://worker.example/v1/inboxes?token=${token}`), workerEnv);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="agentpostoffice"');
    expect(await response.json()).toEqual({ error: { code: "unauthorized", message: "Invalid or expired bearer token" } });
  });

  it("identifies the renamed service in health checks", async () => {
    const response = await handleApi(new Request("https://worker.example/health"), workerEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "agentpostoffice" });
  });

  it("creates logical inboxes and rejects duplicate local parts", async () => {
    const first = await api("/v1/inboxes", { method: "POST", body: JSON.stringify({ local_part: "Research" }) });
    expect(first.status).toBe(201);
    expect((await first.json() as { data: { address: string } }).data.address).toBe("research@mail.example.com");
    const duplicate = await api("/v1/inboxes", { method: "POST", body: JSON.stringify({ local_part: "research" }) });
    expect(duplicate.status).toBe(409);
  });

  it("keyset-paginates same-timestamp messages without skips", async () => {
    await seedInbox();
    for (const id of ["msg_001", "msg_002", "msg_003"]) await seedMessage(id, "2026-07-10T10:00:00.000Z");
    const first = await api("/v1/messages?order=asc&limit=2&state=unprocessed");
    const firstPayload = await first.json() as { data: Array<{ id: string }>; next_cursor: string };
    expect(firstPayload.data.map((message) => message.id)).toEqual(["msg_001", "msg_002"]);
    const second = await api(`/v1/messages?order=asc&limit=2&state=unprocessed&cursor=${encodeURIComponent(firstPayload.next_cursor)}`);
    const secondPayload = await second.json() as { data: Array<{ id: string }>; next_cursor: null };
    expect(secondPayload.data.map((message) => message.id)).toEqual(["msg_003"]);
    expect(secondPayload.next_cursor).toBeNull();
  });

  it("keeps the message ID and omits HTML unless explicitly requested", async () => {
    await seedInbox();
    await seedMessage("msg_identity", "2026-07-10T10:00:00.000Z");
    await env.DB.prepare(
      "UPDATE messages SET parsed_r2_key = 'messages/inb_test/msg_identity/parsed.json' WHERE id = 'msg_identity'",
    ).run();
    await env.MAIL_BUCKET.put(
      "messages/inb_test/msg_identity/parsed.json",
      JSON.stringify({ text: "Plain body", html: "<img src=x onerror=alert(1)>" }),
    );

    const normal = await api("/v1/messages/msg_identity");
    const normalMessage = (await normal.json() as { data: { id: string; inbox: { id: string }; text: string; html?: string } }).data;
    expect(normalMessage.id).toBe("msg_identity");
    expect(normalMessage.inbox.id).toBe("inb_test");
    expect(normalMessage.text).toBe("Plain body");
    expect(normalMessage).not.toHaveProperty("html");

    const explicit = await api("/v1/messages/msg_identity?include_html=true");
    expect((await explicit.json() as { data: { html: string } }).data.html).toBe("<img src=x onerror=alert(1)>");
  });

  it("stores the complete outbound body before attempting delivery", async () => {
    await seedInbox();
    const response = await api("/v1/messages", {
      method: "POST",
      headers: { "Idempotency-Key": "new-send-key" },
      body: JSON.stringify({
        inbox_id: "inb_test",
        to: "person@example.net",
        subject: "Complete body",
        text: "A body that must survive beyond the D1 excerpt",
      }),
    });
    expect(response.status).toBe(202);
    const responseBody = await response.json() as { data: { id: string } };
    const row = await env.DB.prepare(
      "SELECT parsed_r2_key FROM messages WHERE id = ?",
    ).bind(responseBody.data.id).first<{ parsed_r2_key: string | null }>();
    expect(row?.parsed_r2_key).toBeTruthy();
    const stored = await (await env.MAIL_BUCKET.get(row!.parsed_r2_key!))?.json<{ text: string }>();
    expect(stored?.text).toBe("A body that must survive beyond the D1 excerpt");
  });

  it("tombstones immediately before asynchronous deletion", async () => {
    await seedInbox();
    await seedMessage("msg_delete", "2026-07-10T10:00:00.000Z");
    const deleted = await api("/v1/messages/msg_delete", { method: "DELETE" });
    expect(deleted.status).toBe(202);
    const hidden = await api("/v1/messages/msg_delete");
    expect(hidden.status).toBe(404);
    const row = await env.DB.prepare("SELECT tombstoned_at FROM messages WHERE id = 'msg_delete'").first<{ tombstoned_at: string | null }>();
    expect(row?.tombstoned_at).not.toBeNull();
  });

  it("requeues a tombstoned message after a prior Queue admission failure", async () => {
    await seedInbox();
    await seedMessage("msg_delete_retry", "2026-07-10T10:00:00.000Z");

    const failed = await api("/v1/messages/msg_delete_retry", { method: "DELETE" }, queueFailureEnv("send"));
    expect(failed.status).toBe(500);

    const retried = await api("/v1/messages/msg_delete_retry", { method: "DELETE" });

    expect(retried.status).toBe(202);
    expect(await retried.json()).toEqual({
      data: { id: "msg_delete_retry", status: "deletion_queued" },
    });
  });

  it("requeues existing tombstoned messages in a bulk deletion retry", async () => {
    await seedInbox();
    await seedMessage("msg_bulkretry", "2026-07-10T10:00:00.000Z");

    const failed = await api("/v1/messages/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ message_ids: ["msg_bulkretry", "msg_missing"] }),
    }, queueFailureEnv("sendBatch"));
    expect(failed.status).toBe(500);

    const retried = await api("/v1/messages/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ message_ids: ["msg_bulkretry", "msg_missing"] }),
    });

    expect(retried.status).toBe(202);
    expect(await retried.json()).toEqual({
      data: { status: "deletion_queued", message_ids: ["msg_bulkretry"] },
    });
  });

  it("streams raw mail as an attachment with active-content defenses", async () => {
    await seedInbox();
    await seedMessage("msg_raw", "2026-07-10T10:00:00.000Z", "messages/inb_test/msg_raw/raw.eml");
    await env.MAIL_BUCKET.put("messages/inb_test/msg_raw/raw.eml", "<svg onload=alert(1)>");
    const response = await api("/v1/messages/msg_raw/raw");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("returns an existing idempotent send result without sending again", async () => {
    await seedInbox();
    const request = { inbox_id: "inb_test", to: "person@example.net", subject: "Hello", text: "Body" };
    const digest = await sha256Hex(JSON.stringify({
      inboxId: request.inbox_id,
      to: request.to,
      subject: request.subject,
      text: request.text,
      html: null,
      replyTo: null,
      headers: {},
    }));
    await env.DB.prepare(
      `INSERT INTO idempotency_keys
       (api_key_id, endpoint, idempotency_key, request_digest, outbound_message_id, state, response_json, created_at, updated_at)
       VALUES (?, 'POST:/v1/messages', 'repeat-key', ?, 'msg_existing', 'accepted', ?, ?, ?)`,
    ).bind("abcdef1234567890", digest, JSON.stringify({ id: "msg_existing", status: "accepted", cloudflare_message_id: "cf_existing" }), "2026-07-10T00:00:00.000Z", "2026-07-10T00:00:00.000Z").run();
    const response = await api("/v1/messages", {
      method: "POST",
      headers: { "Idempotency-Key": "repeat-key" },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ data: { id: "msg_existing", status: "accepted", cloudflare_message_id: "cf_existing" } });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE direction = 'outbound'").first<{ count: number }>()).toEqual({ count: 0 });
  });
});

async function api(path: string, init: RequestInit = {}, executionEnv = workerEnv): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return handleApi(new Request(`https://worker.example${path}`, { ...init, headers }), executionEnv);
}

function queueFailureEnv(operation: "send" | "sendBatch"): Env {
  return {
    ...workerEnv,
    MAIL_QUEUE: {
      send: operation === "send"
        ? async () => { throw new Error("queue unavailable"); }
        : workerEnv.MAIL_QUEUE.send.bind(workerEnv.MAIL_QUEUE),
      sendBatch: operation === "sendBatch"
        ? async () => { throw new Error("queue unavailable"); }
        : workerEnv.MAIL_QUEUE.sendBatch.bind(workerEnv.MAIL_QUEUE),
    },
  } as Env;
}

async function seedInbox(): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO inboxes (id, domain, local_part, active, created_at, updated_at) VALUES ('inb_test', 'mail.example.com', 'research', 1, ?, ?)",
  ).bind("2026-07-10T00:00:00.000Z", "2026-07-10T00:00:00.000Z").run();
}

async function seedMessage(id: string, receivedAt: string, rawKey: string | null = null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages
     (id, inbox_id, direction, envelope_from, envelope_to, subject, text_excerpt, raw_r2_key, parse_status, agent_state, labels_json, headers_json, received_at, created_at, updated_at)
     VALUES (?, 'inb_test', 'inbound', 'person@example.net', 'research@mail.example.com', 'Question', 'Body', ?, 'ready', 'unprocessed', '[]', '{}', ?, ?, ?)`,
  ).bind(id, rawKey, receivedAt, receivedAt, receivedAt).run();
}
