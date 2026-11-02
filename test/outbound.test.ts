import { describe, expect, it, vi } from "vitest";
import { replyToMessage } from "../packages/worker/src/outbound.js";
import type { AuthContext, Env } from "../packages/worker/src/types.js";

const encoder = new TextEncoder();

describe("Cloudflare Email Sending request", () => {
  it("lets Cloudflare generate Message-ID while preserving reply threading headers", async () => {
    const send = vi.fn(async () => ({ messageId: "cloudflare-message-id" }));
    const env = outboundHarness(send);
    const auth = { keyId: "key_1", scopes: ["messages:reply"] } as AuthContext;

    const result = await replyToMessage(
      "msg_original",
      { text: "Reply body" },
      "reply-idempotency-key",
      auth,
      env,
    );

    expect(result.status).toBe(202);
    expect(send).toHaveBeenCalledOnce();
    const request = send.mock.calls[0]?.[0] as { headers?: Record<string, string> };
    expect(request.headers).toEqual({
      "In-Reply-To": "<original@example.net>",
      References: "<earlier@example.net> <original@example.net>",
    });
    expect(request.headers).not.toHaveProperty("Message-ID");
  });

  it("trims References to 2048 bytes by keeping the root id and the newest ids", async () => {
    const ids = Array.from({ length: 120 }, (_, index) => `<m${String(index).padStart(4, "0")}-${"x".repeat(20)}@example.net>`);
    const root = ids[0]!;
    const newest = ids.at(-1)!;
    const droppedMiddle = ids[1]!;
    const send = vi.fn(async () => ({ messageId: "<provider@mail.example.com>" }));
    const env = outboundHarness(send, {
      headers: {
        "message-id": newest,
        references: ids.slice(0, -1).join(" "),
      },
    });

    const result = await replyToMessage("msg_original", { text: "Reply body" }, "trim-references-key", auth(), env);

    expect(result.status).toBe(202);
    const headers = (send.mock.calls[0]?.[0] as { headers: Record<string, string> }).headers;
    const references = headers.References ?? "";
    const tokens = references.split(" ");
    expect(encoder.encode(references).byteLength).toBeLessThanOrEqual(2048);
    expect(encoder.encode(ids.join(" ")).byteLength).toBeGreaterThan(2048);
    expect(tokens[0]).toBe(root);
    expect(tokens.at(-1)).toBe(newest);
    expect(tokens).not.toContain(droppedMiddle);
    expect(tokens.length).toBeGreaterThan(2);
    expect(tokens.length).toBeLessThan(ids.length);
    expect(tokens.every((token) => ids.includes(token))).toBe(true);
    expect(headers["In-Reply-To"]).toBe(newest);
    expect(headers).not.toHaveProperty("Message-ID");
  });

  it("references the provider id when the stored Message-ID was never sent", async () => {
    const synthetic = "<msg_000000000aaaaaaaaaaaaaaaaaaaaaaaa@mail.example.com>";
    const provider = "<provider-real@mail.example.com>";
    const send = vi.fn(async () => ({ messageId: "<next@mail.example.com>" }));
    const env = outboundHarness(send, {
      headers: {
        "message-id": synthetic,
        references: "<earlier@example.net>",
      },
      cloudflare_message_id: provider,
    });

    await replyToMessage("msg_original", { text: "Reply body" }, "provider-id-reply-key", auth(), env);

    const headers = (send.mock.calls[0]?.[0] as { headers: Record<string, string> }).headers;
    expect(headers["In-Reply-To"]).toBe(provider);
    expect(headers.References).toBe(`<earlier@example.net> ${provider}`);
    expect(headers.References).not.toContain(synthetic);
  });

  it("keeps a sender Message-ID that merely resembles an unsent local id", async () => {
    const senderId = "<msg_000000000bbbbbbbbbbbbbbbbbbbbbbbb@example.net>";
    const send = vi.fn(async () => ({ messageId: "<next@mail.example.com>" }));
    const env = outboundHarness(send, {
      headers: { "message-id": senderId, references: "<earlier@example.net>" },
    });

    await replyToMessage("msg_original", { text: "Reply body" }, "sender-shaped-id-key", auth(), env);

    const headers = (send.mock.calls[0]?.[0] as { headers: Record<string, string> }).headers;
    expect(headers["In-Reply-To"]).toBe(senderId);
    expect(headers.References).toBe(`<earlier@example.net> ${senderId}`);
  });
});

function auth(): AuthContext {
  return { keyId: "key_1", scopes: ["messages:reply"] } as AuthContext;
}

function outboundHarness(
  send: ReturnType<typeof vi.fn>,
  message: { headers?: Record<string, string>; cloudflare_message_id?: string | null; thread_id?: string | null } = {},
): Env {
  const original = {
    id: "msg_original",
    inbox_id: "inb_1",
    direction: "inbound",
    envelope_from: "sender@example.net",
    envelope_to: "receive@mail.example.com",
    reply_to: null,
    subject: "Original",
    parse_status: "ready",
    cloudflare_message_id: message.cloudflare_message_id ?? null,
    thread_id: message.thread_id ?? null,
    parent_message_id: null,
    headers_json: JSON.stringify(message.headers ?? {
      "message-id": "<original@example.net>",
      references: "<earlier@example.net>",
    }),
    tombstoned_at: null,
  };
  const inbox = {
    id: "inb_1",
    domain: "mail.example.com",
    local_part: "receive",
    display_name: "Receive",
    active: 1,
    created_at: "now",
    updated_at: "now",
  };
  const prepare = vi.fn((sql: string) => {
    const statement = {
      bind: vi.fn(function () { return this; }),
      first: vi.fn(async () => sql.includes("FROM messages") ? original : inbox),
      run: vi.fn(async () => ({ success: true, meta: { changes: 1 } })),
    };
    return statement;
  });
  return {
    DB: { prepare, batch: vi.fn(async () => []) },
    MAIL_BUCKET: { put: vi.fn(async () => null) },
    MAIL_QUEUE: { send: vi.fn(async () => undefined) },
    EMAIL: { send },
    MAIL_DOMAIN: "mail.example.com",
    BODY_EXCERPT_BYTES: "8192",
  } as unknown as Env;
}
