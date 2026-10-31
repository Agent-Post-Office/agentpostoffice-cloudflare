import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleApi } from "../src/api.js";
import type { Env } from "../src/types.js";
import { sha256Hex } from "../src/util.js";

const workerEnv = env as unknown as Env;
const now = "2026-07-11T00:00:00.000Z";
const token = `apo_pre0005schema1_${"F".repeat(43)}`;

describe("schema before migration 0005", () => {
  it("returns migration_pending for archive reads and writes, and still serves the default feed", async () => {
    const applied = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    expect(applied.results.map((row) => row.name)).toEqual([
      "0001_initial.sql",
      "0002_sieve_automation.sql",
      "0003_message_threads.sql",
      "0004_message_replied.sql",
    ]);
    const columns = await env.DB.prepare("PRAGMA table_info(messages)").all<{ name: string }>();
    expect(columns.results.some((column) => column.name === "archived_at")).toBe(false);

    await env.DB.prepare(
      "INSERT INTO inboxes (id, domain, local_part, display_name, active, created_at, updated_at) VALUES ('inb_home', 'mail.example.com', 'home', 'Home', 1, ?, ?)",
    ).bind(now, now).run();
    await env.DB.prepare(
      "INSERT INTO api_keys (key_id, digest_sha256, label, scopes_json, created_at) VALUES (?, ?, 'test', ?, ?)",
    ).bind(
      "pre0005schema1",
      await sha256Hex(token),
      JSON.stringify(["messages:read", "messages:update"]),
      now,
    ).run();
    await env.DB.prepare(
      `INSERT INTO messages (
        id, inbox_id, direction, envelope_from, envelope_to, subject, text_excerpt,
        parse_status, agent_state, labels_json, headers_json, thread_id,
        replied_at, last_reply_message_id, tombstoned_at, received_at, created_at, updated_at
      ) VALUES ('msg_legacy', 'inb_home', 'inbound', 'person@example.net', 'home@mail.example.com', 'Subject', 'Body',
        'ready', 'unprocessed', '[]', '{}', 'msg_thread_root', NULL, NULL, NULL, ?, ?, ?)`,
    ).bind(now, now, now).run();

    const listFailure = await env.DB.prepare(
      "SELECT m.id FROM messages m WHERE m.archived_at IS NULL",
    ).all().then(() => "", (error: unknown) => errorText(error));
    expect(listFailure).toMatch(/no such column:\s*m\.archived_at\b/i);

    const archivedFilter = await handleApi(readRequest("/v1/messages?archived=false"), workerEnv);
    expect(archivedFilter.status).toBe(503);
    expect(await archivedFilter.json()).toEqual({
      error: { code: "migration_pending", message: "archived_at requires migration 0005" },
    });

    const archivedWrite = await handleApi(patchRequest("msg_legacy", { archived: true }), workerEnv);
    expect(archivedWrite.status).toBe(503);
    expect(await archivedWrite.json()).toEqual({
      error: { code: "migration_pending", message: "archived_at requires migration 0005" },
    });
    expect(await legacyRow()).toEqual({ agent_state: "unprocessed", replied_at: null });

    const listed = await handleApi(readRequest("/v1/messages?order=asc"), workerEnv);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { data: Array<{ id: string; archived_at: string | null }> };
    expect(listedBody.data.map((message) => message.id)).toEqual(["msg_legacy"]);
    expect(listedBody.data[0]?.archived_at).toBeNull();

    const processed = await handleApi(patchRequest("msg_legacy", { state: "processed" }), workerEnv);
    expect(processed.status).toBe(200);
    expect(await legacyRow()).toEqual({ agent_state: "processed", replied_at: null });
  });
});

function readRequest(path: string): Request {
  return new Request(`https://worker.example${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function patchRequest(messageId: string, body: unknown): Request {
  return new Request(`https://worker.example/v1/messages/${messageId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function legacyRow(): Promise<{ agent_state: string; replied_at: string | null }> {
  const stored = await env.DB.prepare(
    "SELECT agent_state, replied_at FROM messages WHERE id = 'msg_legacy'",
  ).first<{ agent_state: string; replied_at: string | null }>();
  if (!stored) throw new Error("missing message msg_legacy");
  return stored;
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") break;
    const record = current as { message?: unknown; cause?: unknown; name?: unknown };
    if (typeof record.message === "string") parts.push(record.message);
    current = record.cause;
  }
  return parts.join("\n");
}
