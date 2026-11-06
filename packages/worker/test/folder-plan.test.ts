import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleApi } from "../src/api.js";
import type { Env } from "../src/types.js";
import { sha256Hex } from "../src/util.js";

const workerEnv = env as unknown as Env;
const now = "2026-11-06T00:00:00.000Z";
const token = `apo_planread12345_${"p".repeat(43)}`;

describe("folder query plans", () => {
  it("keeps the default feed, spam feed, and thread listing on indexes", async () => {
    await env.DB.prepare(
      "INSERT INTO inboxes (id, domain, local_part, active, created_at, updated_at) VALUES ('inb_plan', 'mail.example.com', 'plan', 1, ?, ?)",
    ).bind(now, now).run();
    await env.DB.prepare(
      "INSERT INTO api_keys (key_id, digest_sha256, label, scopes_json, created_at) VALUES (?, ?, 'plan', ?, ?)",
    ).bind("planread12345", await sha256Hex(token), JSON.stringify(["messages:read"]), now).run();
    await env.DB.prepare(
      `INSERT INTO messages (
        id, inbox_id, direction, envelope_from, envelope_to, subject, parse_status, agent_state,
        labels_json, headers_json, thread_id, received_at, created_at, updated_at
      ) VALUES ('msg_plan', 'inb_plan', 'inbound', 'person@example.net', 'plan@mail.example.com', 'Hi',
        'ready', 'unprocessed', '[]', '{}', 'msg_plan', ?, ?, ?)`,
    ).bind(now, now, now).run();

    const queries = await capture([
      "/v1/messages?order=asc&limit=25",
      "/v1/messages?state=unprocessed&order=asc&limit=25",
      "/v1/messages?inbox_id=inb_plan&state=unprocessed&order=asc&limit=25",
      "/v1/messages?thread_id=msg_plan&order=asc&limit=25",
      "/v1/messages?folder=spam&order=asc&limit=25",
      "/v1/messages?folder=all&order=asc&limit=25",
    ]);
    const plans = new Map(await Promise.all(queries.map(async (query) => [query.label, await explain(query)] as const)));

    expect(queries.every((query) => !query.sql.includes("INDEXED BY"))).toBe(true);
    expect(plans.get("/v1/messages?order=asc&limit=25")).toContain("messages_open_inbox_feed_idx");
    expect(plans.get("/v1/messages?state=unprocessed&order=asc&limit=25")).toContain("messages_poll_idx");
    expect(plans.get("/v1/messages?inbox_id=inb_plan&state=unprocessed&order=asc&limit=25")).toContain("messages_inbox_poll_idx");
    expect(plans.get("/v1/messages?thread_id=msg_plan&order=asc&limit=25")).toContain("messages_thread_feed_idx");
    expect(plans.get("/v1/messages?thread_id=msg_plan&order=asc&limit=25")).not.toContain("messages_open_inbox_feed_idx");
    expect(plans.get("/v1/messages?folder=spam&order=asc&limit=25")).toContain("messages_open_spam_feed_idx");
    expect(plans.get("/v1/messages?folder=all&order=asc&limit=25")).toContain("messages_feed_idx");
    expect(plans.get("/v1/messages?folder=all&order=asc&limit=25")).not.toContain("messages_open_inbox_feed_idx");
  });
});

async function capture(paths: string[]): Promise<Array<{ label: string; sql: string; bindings: unknown[] }>> {
  const found: Array<{ label: string; sql: string; bindings: unknown[] }> = [];
  for (const path of paths) {
    const prepared: Array<{ sql: string; bindings: unknown[] }> = [];
    const response = await handleApi(new Request(`https://worker.example${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    }), recordingEnv(prepared));
    expect(response.status, path).toBe(200);
    const list = prepared.find((entry) => entry.sql.includes("FROM messages m"));
    if (!list) throw new Error(`missing list sql for ${path}`);
    found.push({ label: path, sql: list.sql, bindings: list.bindings });
  }
  return found;
}

function recordingEnv(prepared: Array<{ sql: string; bindings: unknown[] }>): Env {
  const database = env.DB;
  return {
    ...workerEnv,
    DB: {
      prepare(sql: string) {
        const statement = database.prepare(sql);
        return {
          bind(...values: unknown[]) {
            prepared.push({ sql, bindings: values });
            return statement.bind(...values);
          },
        };
      },
      batch: (statements: D1PreparedStatement[]) => database.batch(statements),
      exec: database.exec.bind(database),
    },
  } as Env;
}

async function explain(query: { sql: string; bindings: unknown[] }): Promise<string> {
  const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.bindings).all<{ detail: string }>();
  return plan.results.map((row) => row.detail).join(" | ");
}
