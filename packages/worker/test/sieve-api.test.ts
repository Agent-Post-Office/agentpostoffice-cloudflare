import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleApi } from "../src/api.js";
import type { Env } from "../src/types.js";
import { sha256Hex } from "../src/util.js";

const token = `apo_sieve123456789_${"B".repeat(43)}`;
const now = "2026-07-11T00:00:00.000Z";
const source = 'require ["envelope", "vacation"]; if envelope :is "to" "itworks@mail.example.com" { vacation :days 365 :handle "welcome" "Welcome."; stop; }';
const workerEnv = env as unknown as Env;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sieve_vacation_responses"),
    env.DB.prepare("DELETE FROM sieve_runs"),
    env.DB.prepare("DELETE FROM sieve_scripts"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM inboxes"),
    env.DB.prepare("DELETE FROM api_keys"),
  ]);
  await env.DB.prepare(
    "INSERT INTO inboxes (id, domain, local_part, active, created_at, updated_at) VALUES ('inb_sieve', 'mail.example.com', 'itworks', 1, ?, ?)",
  ).bind(now, now).run();
  await insertToken(["sieve:read", "sieve:manage"]);
});

describe("Sieve management API", () => {
  it("validates, stores, activates, lists, and disables immutable revisions", async () => {
    const validation = await api("/v1/inboxes/inb_sieve/sieve/validate", { method: "POST", body: JSON.stringify({ source }) });
    expect(validation.status).toBe(200);
    expect(await validation.json()).toEqual({ data: { valid: true, profile: "agentpostoffice-autoresponder-v1" } });

    const created = await api("/v1/inboxes/inb_sieve/sieve", { method: "POST", body: JSON.stringify({ name: "Welcome", source }) });
    expect(created.status).toBe(201);
    const script = (await created.json() as { data: { id: string; revision: number; active: boolean } }).data;
    expect(script).toMatchObject({ revision: 1, active: false });

    await env.DB.prepare(
      `INSERT INTO messages
       (id, inbox_id, direction, envelope_from, envelope_to, subject, parse_status, agent_state, labels_json, headers_json, received_at, created_at, updated_at)
       VALUES ('msg_dry_run', 'inb_sieve', 'inbound', 'person@example.net', 'itworks@mail.example.com', 'Agent Post Office installation check', 'ready', 'unprocessed', '[]', '{}', ?, ?, ?)`,
    ).bind(now, now, now).run();
    const dryRun = await api(`/v1/inboxes/inb_sieve/sieve/${script.id}/test`, {
      method: "POST",
      body: JSON.stringify({ message_id: "msg_dry_run" }),
    });
    expect(dryRun.status).toBe(200);
    expect((await dryRun.json() as { data: { plan: { kind: string } } }).data.plan.kind).toBe("vacation");

    const activated = await api(`/v1/inboxes/inb_sieve/sieve/${script.id}/activate`, { method: "POST" });
    expect(activated.status).toBe(200);
    expect((await activated.json() as { data: { active: boolean } }).data.active).toBe(true);

    const listed = await api("/v1/inboxes/inb_sieve/sieve");
    expect((await listed.json() as { data: Array<{ id: string; active: boolean }> }).data).toEqual([
      expect.objectContaining({ id: script.id, active: true }),
    ]);

    const disabled = await api("/v1/inboxes/inb_sieve/sieve", { method: "DELETE" });
    expect(disabled.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sieve_scripts WHERE active = 1").first()).toEqual({ count: 0 });
  });

  it("does not let a read-only Sieve token activate mail sending", async () => {
    await env.DB.prepare("DELETE FROM api_keys").run();
    await insertToken(["sieve:read"]);
    const response = await api("/v1/inboxes/inb_sieve/sieve", { method: "POST", body: JSON.stringify({ name: "Welcome", source }) });
    expect(response.status).toBe(403);
  });
});

async function insertToken(scopes: string[]): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO api_keys (key_id, digest_sha256, label, scopes_json, created_at) VALUES ('sieve123456789', ?, 'sieve-test', ?, ?)",
  ).bind(await sha256Hex(token), JSON.stringify(scopes), now).run();
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return handleApi(new Request(`https://worker.example${path}`, { ...init, headers }), workerEnv);
}
