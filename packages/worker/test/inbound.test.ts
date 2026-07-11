import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleInbound, type ForwardableEmailMessage } from "../src/inbound.js";
import type { Env } from "../src/types.js";

const workerEnv = env as unknown as Env;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM inboxes"),
  ]);
  await env.DB.prepare(
    "INSERT INTO inboxes (id, domain, local_part, active, created_at, updated_at) VALUES ('inb_receive', 'mail.example.com', 'receive', 1, ?, ?)",
  ).bind("2026-07-11T00:00:00.000Z", "2026-07-11T00:00:00.000Z").run();
});

describe("inbound Email Worker persistence", () => {
  it("stores byte-exact mail from an unknown-length stream in R2", async () => {
    const raw = new TextEncoder().encode("From: sender@example.net\r\nTo: receive@mail.example.com\r\n\r\nhello");
    const message: ForwardableEmailMessage = {
      from: "sender@example.net",
      to: "receive@mail.example.com",
      headers: new Headers(),
      raw: new ReadableStream({ start(controller) { controller.enqueue(raw); controller.close(); } }),
      rawSize: raw.byteLength,
      setReject: () => { throw new Error("message was unexpectedly rejected"); },
    };

    await handleInbound(message, workerEnv);

    const row = await env.DB.prepare(
      "SELECT raw_r2_key FROM messages WHERE inbox_id = 'inb_receive'",
    ).first<{ raw_r2_key: string }>();
    expect(row?.raw_r2_key).toBeTruthy();
    expect(new Uint8Array(await (await env.MAIL_BUCKET.get(row!.raw_r2_key))!.arrayBuffer())).toEqual(raw);
  });
});
