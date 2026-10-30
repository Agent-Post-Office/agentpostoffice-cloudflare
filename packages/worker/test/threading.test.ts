import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/api.js";
import { handleInbound, type ForwardableEmailMessage } from "../src/inbound.js";
import { replyToMessage } from "../src/outbound.js";
import { parseMessage } from "../src/queue.js";
import type { AuthContext, Env } from "../src/types.js";
import { sha256Hex } from "../src/util.js";

const workerEnv = env as unknown as Env;
const now = "2026-07-11T00:00:00.000Z";
const token = `apo_abcdef1234567890_${"B".repeat(43)}`;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM idempotency_keys"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM inboxes"),
    env.DB.prepare("DELETE FROM api_keys"),
  ]);
  await env.DB.prepare(
    "INSERT INTO inboxes (id, domain, local_part, display_name, active, created_at, updated_at) VALUES ('inb_thread', 'mail.example.com', 'receive', 'Receive', 1, ?, ?)",
  ).bind(now, now).run();
  await env.DB.prepare(
    "INSERT INTO api_keys (key_id, digest_sha256, label, scopes_json, created_at) VALUES (?, ?, 'test', ?, ?)",
  ).bind("abcdef1234567890", await sha256Hex(token), JSON.stringify(["messages:read", "messages:reply"]), now).run();
});

describe("stored outbound Message-ID", () => {
  it("stores the provider Message-ID and threads the reply onto its parent", async () => {
    await seedInbound({
      id: "msg_parent",
      messageId: "<parent@example.net>",
      references: "<root@example.net>",
      threadId: "msg_root",
    });
    const send = vi.fn(async () => ({ messageId: "<real-provider@mail.example.com>" }));
    const result = await replyToMessage(
      "msg_parent",
      { text: "Thanks" },
      "thread-reply-key",
      auth(),
      { ...workerEnv, EMAIL: { send } },
    );

    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({
      status: "accepted",
      cloudflare_message_id: "<real-provider@mail.example.com>",
    });
    const sent = send.mock.calls[0]?.[0] as { headers?: Record<string, string> };
    expect(sent.headers).not.toHaveProperty("Message-ID");
    expect(sent.headers?.["In-Reply-To"]).toBe("<parent@example.net>");

    const row = await env.DB.prepare(
      "SELECT id, headers_json, cloudflare_message_id, parent_message_id, thread_id, parsed_r2_key FROM messages WHERE direction = 'outbound'",
    ).first<StoredThreadRow>();
    expect(row?.cloudflare_message_id).toBe("<real-provider@mail.example.com>");
    expect(JSON.parse(row!.headers_json)["message-id"]).toBe("<real-provider@mail.example.com>");
    expect(JSON.parse(row!.headers_json)["message-id"]).not.toMatch(/^<msg_[0-9a-z]+@/i);
    expect(row?.parent_message_id).toBe("msg_parent");
    expect(row?.thread_id).toBe("msg_root");
    const parsed = await (await env.MAIL_BUCKET.get(row!.parsed_r2_key!))!.json<{ messageId: string | null }>();
    expect(parsed.messageId).toBe("<real-provider@mail.example.com>");

    const legacy = await env.DB.prepare("SELECT thread_id FROM messages WHERE id = 'msg_parent'").first<{ thread_id: string | null }>();
    expect(legacy?.thread_id).toBe("msg_root");
  });

  it("does not invent a Message-ID when the provider returns none", async () => {
    await seedInbound({ id: "msg_parent", messageId: "<parent@example.net>" });
    const send = vi.fn(async () => ({ messageId: "  " }));
    const result = await replyToMessage(
      "msg_parent",
      { text: "Thanks" },
      "missing-provider-id-key",
      auth(),
      { ...workerEnv, EMAIL: { send } },
    );

    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ status: "accepted", cloudflare_message_id: null });
    const row = await env.DB.prepare(
      "SELECT headers_json, cloudflare_message_id, parsed_r2_key FROM messages WHERE direction = 'outbound'",
    ).first<StoredThreadRow>();
    expect(row?.cloudflare_message_id).toBeNull();
    expect(JSON.parse(row!.headers_json)).not.toHaveProperty("message-id");
    const parsed = await (await env.MAIL_BUCKET.get(row!.parsed_r2_key!))!.json<{ messageId: string | null }>();
    expect(parsed.messageId).toBeNull();
  });

  it("keeps a legacy inbound row unchanged when a reply adopts its id as the thread", async () => {
    await seedInbound({ id: "msg_legacy", messageId: "<legacy@example.net>" });
    const send = vi.fn(async () => ({ messageId: "<reply-provider@mail.example.com>" }));
    await replyToMessage(
      "msg_legacy",
      { text: "Thanks" },
      "legacy-thread-key",
      auth(),
      { ...workerEnv, EMAIL: { send } },
    );

    const legacy = await env.DB.prepare(
      "SELECT parent_message_id, thread_id FROM messages WHERE id = 'msg_legacy'",
    ).first<{ parent_message_id: string | null; thread_id: string | null }>();
    expect(legacy).toEqual({ parent_message_id: null, thread_id: null });
    const reply = await env.DB.prepare(
      "SELECT parent_message_id, thread_id FROM messages WHERE direction = 'outbound'",
    ).first<{ parent_message_id: string | null; thread_id: string | null }>();
    expect(reply).toEqual({ parent_message_id: "msg_legacy", thread_id: "msg_legacy" });
  });
});

describe("inbound thread links", () => {
  it("resolves In-Reply-To against the provider id recipients saw, including bracket variants", async () => {
    await seedOutbound({
      id: "msg_sent",
      providerId: "real-provider@mail.example.com",
      threadId: "msg_sent",
    });
    await handleInbound(inboundMessage({
      messageId: "<followup@example.net>",
      inReplyTo: "<real-provider@mail.example.com>",
      references: "<root@example.net> <real-provider@mail.example.com>",
    }), workerEnv);

    const row = await env.DB.prepare(
      "SELECT parent_message_id, thread_id FROM messages WHERE direction = 'inbound' ORDER BY created_at DESC",
    ).first<{ parent_message_id: string | null; thread_id: string | null }>();
    expect(row).toEqual({ parent_message_id: "msg_sent", thread_id: "msg_sent" });
  });

  it("uses the nearest stored References ancestor and starts a thread when nothing matches", async () => {
    await seedOutbound({
      id: "msg_root_row",
      providerId: "<root@example.net>",
      threadId: "msg_root_row",
    });
    await handleInbound(inboundMessage({
      messageId: "<child@example.net>",
      references: "<root@example.net> <missing-middle@example.net>",
    }), workerEnv);

    const linked = await env.DB.prepare(
      "SELECT parent_message_id, thread_id FROM messages WHERE direction = 'inbound'",
    ).first<{ parent_message_id: string | null; thread_id: string | null }>();
    expect(linked).toEqual({ parent_message_id: "msg_root_row", thread_id: "msg_root_row" });

    await handleInbound(inboundMessage({
      messageId: "<fresh@example.net>",
      references: "<nobody@example.net>",
    }), workerEnv);
    const fresh = await env.DB.prepare(
      "SELECT id, parent_message_id, thread_id FROM messages WHERE json_extract(headers_json, '$.\"message-id\"') = '<fresh@example.net>'",
    ).first<{ id: string; parent_message_id: string | null; thread_id: string | null }>();
    expect(fresh?.parent_message_id).toBeNull();
    expect(fresh?.thread_id).toBe(fresh?.id);
  });

  it("refines the link from parsed MIME when the envelope headers had no thread", async () => {
    await seedOutbound({
      id: "msg_sent",
      providerId: "<real-provider@mail.example.com>",
      threadId: "msg_conversation",
    });
    const raw = [
      "From: Person <person@example.net>",
      "To: receive@mail.example.com",
      "Subject: Follow up",
      "Message-ID: <followup@example.net>",
      "In-Reply-To: <real-provider@mail.example.com>",
      "References: <root@example.net> <real-provider@mail.example.com>",
      "",
      "Hello",
    ].join("\r\n");
    await handleInbound(inboundMessage({ raw, headers: new Headers({ subject: "Follow up" }) }), workerEnv);
    const pending = await env.DB.prepare(
      "SELECT id, parent_message_id, thread_id, raw_r2_key FROM messages WHERE direction = 'inbound'",
    ).first<{ id: string; parent_message_id: string | null; thread_id: string | null; raw_r2_key: string }>();
    expect(pending?.parent_message_id).toBeNull();
    expect(pending?.thread_id).toBe(pending?.id);

    await parseMessage({ kind: "parse", messageId: pending!.id, rawR2Key: pending!.raw_r2_key }, workerEnv);
    const ready = await env.DB.prepare(
      "SELECT parent_message_id, thread_id FROM messages WHERE id = ?",
    ).bind(pending!.id).first<{ parent_message_id: string | null; thread_id: string | null }>();
    expect(ready).toEqual({ parent_message_id: "msg_sent", thread_id: "msg_conversation" });
  });

  it("returns the thread link from the message API without changing legacy rows", async () => {
    await seedInbound({
      id: "msg_visible",
      messageId: "<visible@example.net>",
      parentMessageId: "msg_parent",
      threadId: "msg_root",
    });
    const response = await handleApi(new Request("https://worker.example/v1/messages/msg_visible", {
      headers: { Authorization: `Bearer ${token}` },
    }), workerEnv);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { parent_message_id: string | null; thread_id: string | null } };
    expect(body.data.parent_message_id).toBe("msg_parent");
    expect(body.data.thread_id).toBe("msg_root");
  });
});

function auth(): AuthContext {
  return { keyId: "abcdef1234567890", scopes: ["messages:reply"] };
}

async function seedInbound(input: {
  id: string;
  messageId: string;
  references?: string;
  threadId?: string | null;
  parentMessageId?: string | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages (
      id, inbox_id, direction, envelope_from, envelope_to, reply_to, subject, text_excerpt,
      parse_status, agent_state, labels_json, headers_json, parent_message_id, thread_id,
      received_at, created_at, updated_at
    ) VALUES (?, 'inb_thread', 'inbound', 'person@example.net', 'receive@mail.example.com', NULL, 'Original', 'Body',
      'ready', 'unprocessed', '[]', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.id,
    JSON.stringify({
      "message-id": input.messageId,
      ...(input.references ? { references: input.references } : {}),
    }),
    input.parentMessageId ?? null,
    input.threadId ?? null,
    now,
    now,
    now,
  ).run();
}

async function seedOutbound(input: { id: string; providerId: string; threadId: string }): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages (
      id, inbox_id, direction, envelope_from, envelope_to, subject, parse_status, agent_state,
      labels_json, headers_json, outbound_status, cloudflare_message_id, parent_message_id, thread_id,
      received_at, created_at, updated_at
    ) VALUES (?, 'inb_thread', 'outbound', 'receive@mail.example.com', 'person@example.net', 'Re: Original',
      'not_applicable', 'processed', '[]', ?, 'accepted', ?, NULL, ?, ?, ?, ?)`,
  ).bind(
    input.id,
    JSON.stringify({ "message-id": input.providerId }),
    input.providerId,
    input.threadId,
    now,
    now,
    now,
  ).run();
}

function inboundMessage(input: {
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  raw?: string;
  headers?: Headers;
}): ForwardableEmailMessage {
  const headers = input.headers ?? new Headers();
  if (input.messageId) headers.set("message-id", input.messageId);
  if (input.inReplyTo) headers.set("in-reply-to", input.inReplyTo);
  if (input.references) headers.set("references", input.references);
  const raw = new TextEncoder().encode(input.raw ?? "From: person@example.net\r\nTo: receive@mail.example.com\r\n\r\nhello");
  return {
    from: "person@example.net",
    to: "receive@mail.example.com",
    headers,
    raw: new ReadableStream({ start(controller) { controller.enqueue(raw); controller.close(); } }),
    rawSize: raw.byteLength,
    setReject: () => { throw new Error("message was unexpectedly rejected"); },
  };
}

interface StoredThreadRow {
  id?: string;
  headers_json: string;
  cloudflare_message_id: string | null;
  parent_message_id: string | null;
  thread_id: string | null;
  parsed_r2_key: string | null;
}
