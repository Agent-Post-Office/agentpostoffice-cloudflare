import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleApi } from "../src/api.js";
import type { Env } from "../src/types.js";
import { sha256Hex } from "../src/util.js";

const workerEnv = env as unknown as Env & { PENDING_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const now = "2026-11-06T00:00:00.000Z";
const token = `apo_upgrade0008x_${"u".repeat(43)}`;

describe("migration 0008 on an existing 0007 database", () => {
  it("adds training tables without rewriting messages and keeps the rules feed", async () => {
    const beforeNames = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    expect(beforeNames.results.map((row) => row.name)).toContain("0007_message_spam.sql");
    expect(beforeNames.results.map((row) => row.name)).not.toContain("0008_spam_learn.sql");

    await env.DB.prepare(
      "INSERT INTO inboxes (id, domain, local_part, display_name, active, created_at, updated_at) VALUES ('inb_legacy', 'mail.example.com', 'legacy', 'Legacy', 1, ?, ?)",
    ).bind(now, now).run();
    await env.DB.prepare(
      "INSERT INTO api_keys (key_id, digest_sha256, label, scopes_json, created_at) VALUES (?, ?, 'upgrade', ?, ?)",
    ).bind("upgrade0008x", await sha256Hex(token), JSON.stringify(["messages:read", "messages:update"]), now).run();
    await env.DB.prepare(
      `INSERT INTO messages (
        id, inbox_id, direction, envelope_from, envelope_to, subject, text_excerpt,
        parse_status, agent_state, labels_json, headers_json, folder, spam_score, spam_reasons_json, spam_verdict,
        thread_id, received_at, created_at, updated_at
      ) VALUES ('msg_legacy', 'inb_legacy', 'inbound', 'person@example.net', 'legacy@mail.example.com', 'Keep me', 'Body',
        'ready', 'unprocessed', '[]', '{}', 'inbox', NULL, NULL, NULL, 'msg_legacy', ?, ?, ?)`,
    ).bind(now, now, now).run();

    const pending = await handleApi(read("/v1/inboxes/inb_legacy/spam-training"), workerEnv);
    expect(pending.status).toBe(503);
    expect(await pending.json()).toEqual({
      error: { code: "migration_pending", message: "spam training requires migration 0008" },
    });

    const listedBefore = await list();
    const beforeRow = await env.DB.prepare(
      "SELECT folder, spam_score, spam_reasons_json, spam_verdict, subject, text_excerpt, labels_json FROM messages WHERE id = 'msg_legacy'",
    ).first();

    await applyD1Migrations(env.DB, workerEnv.PENDING_MIGRATIONS);

    const afterNames = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    expect(afterNames.results.map((row) => row.name)).toContain("0008_spam_learn.sql");
    const afterRow = await env.DB.prepare(
      "SELECT folder, spam_score, spam_reasons_json, spam_verdict, subject, text_excerpt, labels_json FROM messages WHERE id = 'msg_legacy'",
    ).first();
    expect(afterRow).toEqual(beforeRow);
    expect(await list()).toEqual(listedBefore);

    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('inbox_spam_class_counts', 'inbox_spam_token_counts', 'message_spam_training') ORDER BY name",
    ).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      "inbox_spam_class_counts",
      "inbox_spam_token_counts",
      "message_spam_training",
    ]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM message_spam_training").first()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM inbox_spam_token_counts").first()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM inbox_spam_class_counts").first()).toEqual({ count: 0 });

    const ready = await handleApi(read("/v1/inboxes/inb_legacy/spam-training"), workerEnv);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      data: {
        inbox_id: "inb_legacy",
        spam_messages: 0,
        ham_messages: 0,
        tokens: 0,
        min_marks: 20,
        learning: false,
        ready: false,
      },
    });
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
