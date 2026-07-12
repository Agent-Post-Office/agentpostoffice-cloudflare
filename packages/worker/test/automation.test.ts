import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeAutomationTask } from "../src/automation.js";
import type { Env } from "../src/types.js";

const now = "2026-07-11T00:00:00.000Z";
const scriptSource = `
require ["envelope", "vacation"];
if allof (
  envelope :is "to" "itworks@mail.example.com",
  header :is "subject" "Agent Post Office installation check"
) {
  vacation :days 365 :handle "installation-welcome-v1" :subject "It works" "Welcome.";
  stop;
}`;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sieve_vacation_responses"),
    env.DB.prepare("DELETE FROM sieve_runs"),
    env.DB.prepare("DELETE FROM sieve_scripts"),
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM idempotency_keys"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM inboxes"),
    env.DB.prepare("DELETE FROM api_keys"),
  ]);
  await env.DB.prepare(
    "INSERT INTO inboxes (id, domain, local_part, active, created_at, updated_at) VALUES ('inb_itworks', 'mail.example.com', 'itworks', 1, ?, ?)",
  ).bind(now, now).run();
  await env.DB.prepare(
    `INSERT INTO sieve_scripts
      (id, inbox_id, name, revision, source, compiled_ir_json, source_sha256, active, created_at, updated_at)
     VALUES ('siv_welcome', 'inb_itworks', 'Welcome', 1, ?, '{}', ?, 1, ?, ?)`,
  ).bind(scriptSource, "a".repeat(64), now, now).run();
});

describe("Sieve automation queue", () => {
  it("sends one vacation reply and marks the inbound message processed", async () => {
    await seedMessage("msg_install", "person@example.net", {});
    const send = vi.fn(async () => ({ messageId: "provider-auto-1" }));
    const workerEnv = { ...(env as unknown as Env), EMAIL: { send } };

    const task = { kind: "automate" as const, messageId: "msg_install", scriptId: "siv_welcome", scriptRevision: 1 };
    await executeAutomationTask(task, workerEnv);
    await executeAutomationTask(task, workerEnv);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      to: "person@example.net",
      subject: "It works",
      headers: { "Auto-Submitted": "auto-replied" },
    });
    expect(await env.DB.prepare("SELECT agent_state FROM messages WHERE id = 'msg_install'").first()).toEqual({ agent_state: "processed" });
    expect(await env.DB.prepare("SELECT state FROM sieve_runs WHERE message_id = 'msg_install'").first()).toEqual({ state: "sent" });
    expect(await env.DB.prepare(
      "SELECT direction, outbound_status, envelope_to FROM messages WHERE direction = 'outbound'",
    ).first()).toEqual({ direction: "outbound", outbound_status: "accepted", envelope_to: "person@example.net" });
  });

  it("suppresses unsafe automatic mail before creating an execution claim", async () => {
    await seedMessage("msg_loop", "person@example.net", { "auto-submitted": "auto-replied" });
    const send = vi.fn(async () => ({ messageId: "never" }));
    await executeAutomationTask(
      { kind: "automate", messageId: "msg_loop", scriptId: "siv_welcome", scriptRevision: 1 },
      { ...(env as unknown as Env), EMAIL: { send } },
    );
    expect(send).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sieve_runs").first()).toEqual({ count: 0 });
  });

  it("uses vacation cooldown across distinct messages from one sender", async () => {
    await seedMessage("msg_first", "person@example.net", {});
    await seedMessage("msg_second", "person@example.net", {});
    const send = vi.fn(async () => ({ messageId: crypto.randomUUID() }));
    const workerEnv = { ...(env as unknown as Env), EMAIL: { send } };
    await executeAutomationTask({ kind: "automate", messageId: "msg_first", scriptId: "siv_welcome", scriptRevision: 1 }, workerEnv);
    await executeAutomationTask({ kind: "automate", messageId: "msg_second", scriptId: "siv_welcome", scriptRevision: 1 }, workerEnv);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT agent_state FROM messages WHERE id = 'msg_second'").first()).toEqual({ agent_state: "unprocessed" });
  });

  it("unwraps a Cloudflare bounce sender only to a matching visible From domain", async () => {
    await seedMessage("msg_cloudflare", "bounce-token@cf-bounce.sender.example", {}, "sender@sender.example");
    const send = vi.fn(async () => ({ messageId: "provider-auto-cf" }));
    await executeAutomationTask(
      { kind: "automate", messageId: "msg_cloudflare", scriptId: "siv_welcome", scriptRevision: 1 },
      { ...(env as unknown as Env), EMAIL: { send } },
    );
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "sender@sender.example" }));

    await seedMessage("msg_spoof", "bounce-token-2@cf-bounce.sender.example", {}, "victim@other.example");
    await executeAutomationTask(
      { kind: "automate", messageId: "msg_spoof", scriptId: "siv_welcome", scriptRevision: 1 },
      { ...(env as unknown as Env), EMAIL: { send } },
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
});

async function seedMessage(id: string, sender: string, headers: Record<string, string>, visibleFrom?: string): Promise<void> {
  const parsedKey = visibleFrom ? `messages/inb_itworks/${id}/parsed.json` : null;
  if (parsedKey) await env.MAIL_BUCKET.put(parsedKey, JSON.stringify({ from: { address: visibleFrom } }));
  await env.DB.prepare(
    `INSERT INTO messages
      (id, inbox_id, direction, envelope_from, envelope_to, subject, parsed_r2_key, parse_status, agent_state, labels_json, headers_json, received_at, created_at, updated_at)
     VALUES (?, 'inb_itworks', 'inbound', ?, 'itworks@mail.example.com', 'Agent Post Office installation check', ?, 'ready', 'unprocessed', '[]', ?, ?, ?, ?)`,
  ).bind(id, sender, parsedKey, JSON.stringify({ subject: "Agent Post Office installation check", ...headers }), now, now, now).run();
}
