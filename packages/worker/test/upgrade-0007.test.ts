import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleApi } from "../src/api.js";
import type { Env } from "../src/types.js";
import { sha256Hex } from "../src/util.js";

const workerEnv = env as unknown as Env & { PENDING_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const now = "2026-11-06T00:00:00.000Z";
const token = `apo_upgrade0007x_${"u".repeat(43)}`;

describe("migration 0007 on an existing 0006 database", () => {
  it("defaults existing rows to inbox and keeps folder-less reads", async () => {
    const beforeNames = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    expect(beforeNames.results.map((row) => row.name)).toEqual([
      "0001_initial.sql",
      "0002_sieve_automation.sql",
      "0003_message_threads.sql",
      "0004_message_replied.sql",
      "0005_message_archived.sql",
      "0006_message_thread_feed.sql",
    ]);

    await env.DB.prepare(
      "INSERT INTO inboxes (id, domain, local_part, display_name, active, created_at, updated_at) VALUES ('inb_legacy', 'mail.example.com', 'legacy', 'Legacy', 1, ?, ?)",
    ).bind(now, now).run();
    await env.DB.prepare(
      "INSERT INTO api_keys (key_id, digest_sha256, label, scopes_json, created_at) VALUES (?, ?, 'upgrade', ?, ?)",
    ).bind("upgrade0007x", await sha256Hex(token), JSON.stringify(["messages:read"]), now).run();
    await env.DB.prepare(
      `INSERT INTO messages (
        id, inbox_id, direction, envelope_from, envelope_to, subject, text_excerpt,
        parse_status, agent_state, labels_json, headers_json, thread_id,
        received_at, created_at, updated_at
      ) VALUES ('msg_legacy', 'inb_legacy', 'inbound', 'person@example.net', 'legacy@mail.example.com', 'Keep me', 'Body',
        'ready', 'unprocessed', '[]', '{}', 'msg_legacy', ?, ?, ?)`,
    ).bind(now, now, now).run();

    const pendingFolder = await handleApi(read("/v1/messages?folder=inbox&order=asc"), workerEnv);
    expect(pendingFolder.status).toBe(503);

    const listedBefore = await list();
    const polledBefore = await poll();
    expect(listedBefore.data.map((message) => message.id)).toEqual(["msg_legacy"]);
    expect(polledBefore).toEqual(["msg_legacy"]);

    await applyD1Migrations(env.DB, workerEnv.PENDING_MIGRATIONS);

    const afterNames = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    expect(afterNames.results.map((row) => row.name)).toContain("0007_message_spam.sql");
    const stored = await env.DB.prepare(
      "SELECT folder, spam_score, spam_reasons_json, spam_verdict, subject, text_excerpt, labels_json FROM messages WHERE id = 'msg_legacy'",
    ).first<{
      folder: string;
      spam_score: number | null;
      spam_reasons_json: string | null;
      spam_verdict: string | null;
      subject: string;
      text_excerpt: string;
      labels_json: string;
    }>();
    expect(stored).toEqual({
      folder: "inbox",
      spam_score: null,
      spam_reasons_json: null,
      spam_verdict: null,
      subject: "Keep me",
      text_excerpt: "Body",
      labels_json: "[]",
    });

    const listedAfter = await list();
    const polledAfter = await poll();
    expect(listedAfter).toEqual(listedBefore);
    expect(polledAfter).toEqual(polledBefore);
    expect(listedAfter.data[0]).toMatchObject({
      id: "msg_legacy",
      subject: "Keep me",
      state: "unprocessed",
      folder: "inbox",
      spam: { verdict: null, score: null, reasons: [] },
    });

    const inbox = await handleApi(read("/v1/messages?folder=inbox&order=asc"), workerEnv);
    expect(inbox.status).toBe(200);
    expect((await inbox.json() as { data: Array<{ id: string }> }).data.map((message) => message.id)).toEqual(["msg_legacy"]);

    await env.DB.prepare(
      `INSERT INTO messages (
        id, inbox_id, direction, envelope_from, envelope_to, subject, text_excerpt,
        parse_status, agent_state, labels_json, headers_json, received_at, created_at, updated_at
      ) VALUES ('msg_after', 'inb_legacy', 'inbound', 'person@example.net', 'legacy@mail.example.com', 'After', 'More',
        'ready', 'unprocessed', '[]', '{}', ?, ?, ?)`,
    ).bind("2026-11-06T01:00:00.000Z", "2026-11-06T01:00:00.000Z", "2026-11-06T01:00:00.000Z").run();
    expect(await env.DB.prepare("SELECT folder, spam_verdict FROM messages WHERE id = 'msg_after'").first()).toEqual({
      folder: "inbox",
      spam_verdict: null,
    });

    const indexes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('messages_open_inbox_feed_idx', 'messages_open_spam_feed_idx', 'messages_thread_feed_idx') ORDER BY name",
    ).all<{ name: string }>();
    expect(indexes.results.map((row) => row.name)).toEqual([
      "messages_open_inbox_feed_idx",
      "messages_open_spam_feed_idx",
      "messages_thread_feed_idx",
    ]);
  });
});

function read(path: string): Request {
  return new Request(`https://worker.example${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function list(): Promise<{ data: Array<Record<string, unknown>> }> {
  const response = await handleApi(read("/v1/messages?order=asc"), workerEnv);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ data: Array<Record<string, unknown>> }>;
}

async function poll(): Promise<string[]> {
  const response = await handleApi(new Request("https://worker.example/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "poll_messages", arguments: {} } }),
  }), workerEnv);
  expect(response.status).toBe(200);
  const body = await response.json() as { result?: { content?: Array<{ text: string }> } };
  const payload = JSON.parse(body.result?.content?.[0]?.text ?? "{}") as { data: { data: Array<{ id: string }> } };
  return payload.data.data.map((message) => message.id);
}
