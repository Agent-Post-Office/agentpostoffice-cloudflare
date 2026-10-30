import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/api.js";
import { acceptedReplyMark } from "../src/outbound.js";
import type { Env } from "../src/types.js";
import { sha256Hex } from "../src/util.js";

const workerEnv = env as unknown as Env;
const now = "2026-07-11T00:00:00.000Z";
const token = `apo_abcdef1234567890_${"C".repeat(43)}`;
const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM idempotency_keys"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM inboxes"),
    env.DB.prepare("DELETE FROM api_keys"),
  ]);
  await env.DB.prepare(
    "INSERT INTO inboxes (id, domain, local_part, display_name, active, created_at, updated_at) VALUES ('inb_reply', 'mail.example.com', 'receive', 'Receive', 1, ?, ?)",
  ).bind(now, now).run();
  await env.DB.prepare(
    "INSERT INTO inboxes (id, domain, local_part, display_name, active, created_at, updated_at) VALUES ('inb_other', 'mail.example.com', 'other', 'Other', 1, ?, ?)",
  ).bind(now, now).run();
  await env.DB.prepare(
    "INSERT INTO api_keys (key_id, digest_sha256, label, scopes_json, created_at) VALUES (?, ?, 'test', ?, ?)",
  ).bind(
    "abcdef1234567890",
    await sha256Hex(token),
    JSON.stringify(["messages:read", "messages:reply"]),
    now,
  ).run();
});

describe("inbound replied marker", () => {
  it("sets replied_at on the original only after Cloudflare accepts the reply", async () => {
    await seedInbound("msg_original", "inb_reply");
    const scopes = await env.DB.prepare("SELECT scopes_json FROM api_keys WHERE key_id = 'abcdef1234567890'")
      .first<{ scopes_json: string }>();
    expect(JSON.parse(scopes!.scopes_json)).toEqual(["messages:read", "messages:reply"]);

    let repliedDuringSend: string | null = "missing";
    const prepared: string[] = [];
    const send = vi.fn(async () => {
      const during = await env.DB.prepare(
        "SELECT replied_at, agent_state FROM messages WHERE id = 'msg_original'",
      ).first<{ replied_at: string | null; agent_state: string }>();
      repliedDuringSend = during?.replied_at ?? null;
      expect(during?.agent_state).toBe("unprocessed");
      return { messageId: "<accepted-provider@mail.example.com>" };
    });

    const response = await handleApi(replyRequest("msg_original", "reply-accepted-key"), recordingEnv(send, prepared));
    expect(response.status).toBe(202);
    const body = await response.json() as { data: { id: string; status: string } };
    expect(body.data.status).toBe("accepted");
    expect(repliedDuringSend).toBeNull();
    expect(prepared.some((sql) =>
      sql.includes("replied_at") && sql.includes("inbox_id") && sql.includes("direction = 'inbound'"),
    )).toBe(true);

    const original = await marker("msg_original");
    expect(original.replied_at).toMatch(isoTimestamp);
    expect(original.last_reply_message_id).toBe(body.data.id);
    expect(original.agent_state).toBe("unprocessed");
    expect(original.updated_at).toBe(original.replied_at);
    const outbound = await marker(body.data.id);
    expect(outbound.replied_at).toBeNull();
    expect(outbound.inbox_id).toBe("inb_reply");

    const listed = await handleApi(readRequest("/v1/messages?direction=inbound"), workerEnv);
    const listBody = await listed.json() as { data: Array<{ id: string; replied_at: string | null; state: string; last_reply_message_id: string | null }> };
    expect(listBody.data.find((message) => message.id === "msg_original")).toMatchObject({
      replied_at: original.replied_at,
      last_reply_message_id: body.data.id,
      state: "unprocessed",
    });
    const fetched = await handleApi(readRequest("/v1/messages/msg_original"), workerEnv);
    const fetchedBody = await fetched.json() as { data: { replied_at: string | null; state: string; last_reply_message_id: string | null } };
    expect(fetchedBody.data).toMatchObject({
      replied_at: original.replied_at,
      last_reply_message_id: body.data.id,
      state: "unprocessed",
    });
  });

  it("leaves replied_at null when Cloudflare rejects the send", async () => {
    await seedInbound("msg_failed", "inb_reply");
    const send = vi.fn(async () => {
      throw Object.assign(new Error("rejected by email sending"), { code: "rejected" });
    });
    const response = await handleApi(
      replyRequest("msg_failed", "reply-failed-key"),
      { ...workerEnv, EMAIL: { send } },
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ data: { status: "failed" } });
    expect(send).toHaveBeenCalledOnce();
    const original = await marker("msg_failed");
    expect(original.replied_at).toBeNull();
    expect(original.last_reply_message_id).toBeNull();
    expect(original.agent_state).toBe("unprocessed");
    const outbound = await env.DB.prepare(
      "SELECT outbound_status, replied_at FROM messages WHERE direction = 'outbound'",
    ).first<{ outbound_status: string; replied_at: string | null }>();
    expect(outbound).toEqual({ outbound_status: "failed", replied_at: null });
  });

  it("does not mark a message id that belongs to another inbox", async () => {
    await seedInbound("msg_home", "inb_reply");
    await seedInbound("msg_foreign", "inb_other");

    const mismatched = await acceptedReplyMark(workerEnv, {
      originalMessageId: "msg_home",
      inboxId: "inb_other",
      replyMessageId: "msg_foreign",
      repliedAt: "2026-07-12T00:00:00.000Z",
    }).run();
    expect(mismatched.meta.changes).toBe(0);
    expect(await marker("msg_home")).toMatchObject({ replied_at: null, last_reply_message_id: null });
    expect(await marker("msg_foreign")).toMatchObject({ replied_at: null, last_reply_message_id: null });

    const send = vi.fn(async () => ({ messageId: "<home-provider@mail.example.com>" }));
    const response = await handleApi(replyRequest("msg_home", "reply-home-key"), { ...workerEnv, EMAIL: { send } });
    expect(response.status).toBe(202);
    const replyId = ((await response.json()) as { data: { id: string } }).data.id;
    const home = await marker("msg_home");
    expect(home.replied_at).toMatch(isoTimestamp);
    expect(home.last_reply_message_id).toBe(replyId);
    expect(await marker("msg_foreign")).toMatchObject({ replied_at: null, last_reply_message_id: null });

    const crossed = await acceptedReplyMark(workerEnv, {
      originalMessageId: "msg_home",
      inboxId: "inb_other",
      replyMessageId: "msg_foreign",
      repliedAt: "2099-01-01T00:00:00.000Z",
    }).run();
    expect(crossed.meta.changes).toBe(0);
    expect(await marker("msg_home")).toEqual(home);
  });

  it("updates replied_at when a later reply is accepted", async () => {
    await seedInbound("msg_twice", "inb_reply");
    const firstSend = vi.fn(async () => ({ messageId: "<first-provider@mail.example.com>" }));
    const first = await handleApi(replyRequest("msg_twice", "reply-first-key"), { ...workerEnv, EMAIL: { send: firstSend } });
    expect(first.status).toBe(202);
    const firstBody = await first.json() as { data: { id: string } };
    const firstMarker = await marker("msg_twice");
    expect(firstMarker.replied_at).toMatch(isoTimestamp);
    expect(firstMarker.last_reply_message_id).toBe(firstBody.data.id);

    waitForLaterTimestamp(firstMarker.replied_at!);
    const secondSend = vi.fn(async () => ({ messageId: "<second-provider@mail.example.com>" }));
    const second = await handleApi(replyRequest("msg_twice", "reply-second-key"), { ...workerEnv, EMAIL: { send: secondSend } });
    expect(second.status).toBe(202);
    const secondBody = await second.json() as { data: { id: string } };
    const secondMarker = await marker("msg_twice");
    expect(secondMarker.replied_at).toMatch(isoTimestamp);
    expect(Date.parse(secondMarker.replied_at!)).toBeGreaterThan(Date.parse(firstMarker.replied_at!));
    expect(secondMarker.last_reply_message_id).toBe(secondBody.data.id);
    expect(secondMarker.last_reply_message_id).not.toBe(firstBody.data.id);
    expect(secondMarker.agent_state).toBe("unprocessed");
  });

  it("returns replied_at on reads and filters replied without changing processed", async () => {
    await seedInbound("msg_open", "inb_reply", { agentState: "processed" });
    await seedInbound("msg_answered", "inb_reply", { repliedAt: "2026-07-11T03:00:00.000Z", lastReplyMessageId: "msg_prior_reply" });

    const unanswered = await handleApi(readRequest("/v1/messages?replied=false&order=asc"), workerEnv);
    expect(unanswered.status).toBe(200);
    const unansweredBody = await unanswered.json() as { data: Array<{ id: string; replied_at: string | null; state: string }> };
    expect(unansweredBody.data.map((message) => message.id)).toEqual(["msg_open"]);
    expect(unansweredBody.data[0]).toMatchObject({ replied_at: null, state: "processed" });

    const answered = await handleApi(readRequest("/v1/messages?replied=true"), workerEnv);
    const answeredBody = await answered.json() as { data: Array<{ id: string; replied_at: string | null; state: string; last_reply_message_id: string | null }> };
    expect(answeredBody.data.map((message) => message.id)).toEqual(["msg_answered"]);
    expect(answeredBody.data[0]).toMatchObject({
      replied_at: "2026-07-11T03:00:00.000Z",
      last_reply_message_id: "msg_prior_reply",
      state: "unprocessed",
    });

    const stillUnprocessed = await handleApi(readRequest("/v1/messages?state=unprocessed"), workerEnv);
    const stillUnprocessedBody = await stillUnprocessed.json() as { data: Array<{ id: string }> };
    expect(stillUnprocessedBody.data.map((message) => message.id)).toEqual(["msg_answered"]);

    const fetched = await handleApi(readRequest("/v1/messages/msg_open"), workerEnv);
    expect((await fetched.json() as { data: { replied_at: string | null; state: string } }).data).toMatchObject({
      replied_at: null,
      state: "processed",
    });

    const invalid = await handleApi(readRequest("/v1/messages?replied=yes"), workerEnv);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: { code: "invalid_filter", message: "replied is invalid" } });
  });
});

function replyRequest(messageId: string, idempotencyKey: string): Request {
  return new Request(`https://worker.example/v1/messages/${messageId}/reply`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ text: "Thanks" }),
  });
}

function readRequest(path: string): Request {
  return new Request(`https://worker.example${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function recordingEnv(send: ReturnType<typeof vi.fn>, prepared: string[]): Env {
  const database = env.DB;
  return {
    ...workerEnv,
    EMAIL: { send },
    DB: {
      prepare(sql: string) {
        prepared.push(sql);
        return database.prepare(sql);
      },
      batch: (statements: D1PreparedStatement[]) => database.batch(statements),
      exec: database.exec.bind(database),
    },
  } as Env;
}

async function marker(id: string): Promise<{
  replied_at: string | null;
  last_reply_message_id: string | null;
  agent_state: string;
  updated_at: string;
  inbox_id: string;
}> {
  const row = await env.DB.prepare(
    "SELECT replied_at, last_reply_message_id, agent_state, updated_at, inbox_id FROM messages WHERE id = ?",
  ).bind(id).first<{
    replied_at: string | null;
    last_reply_message_id: string | null;
    agent_state: string;
    updated_at: string;
    inbox_id: string;
  }>();
  if (!row) throw new Error(`missing message ${id}`);
  return row;
}

async function seedInbound(
  id: string,
  inboxId: string,
  options: { agentState?: "processed" | "unprocessed"; repliedAt?: string | null; lastReplyMessageId?: string | null } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages (
      id, inbox_id, direction, envelope_from, envelope_to, reply_to, subject, text_excerpt,
      parse_status, agent_state, labels_json, headers_json, received_at, created_at, updated_at,
      replied_at, last_reply_message_id
    ) VALUES (?, ?, 'inbound', 'person@example.net', 'receive@mail.example.com', NULL, 'Original', 'Body',
      'ready', ?, '[]', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    inboxId,
    options.agentState ?? "unprocessed",
    JSON.stringify({ "message-id": `<${id}@example.net>` }),
    now,
    now,
    now,
    options.repliedAt ?? null,
    options.lastReplyMessageId ?? null,
  ).run();
}

function waitForLaterTimestamp(previous: string): void {
  const deadline = Date.now() + 2000;
  while (new Date().toISOString() <= previous) {
    if (Date.now() > deadline) throw new Error("clock did not advance");
  }
}
