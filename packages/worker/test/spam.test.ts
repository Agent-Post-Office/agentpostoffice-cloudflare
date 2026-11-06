import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/api.js";
import { executeAutomationTask } from "../src/automation.js";
import { handleInbound, type ForwardableEmailMessage } from "../src/inbound.js";
import { parseMessage } from "../src/queue.js";
import { DEFAULT_SPAM_THRESHOLD } from "../src/spam.js";
import type { Env } from "../src/types.js";
import { sha256Hex } from "../src/util.js";

const workerEnv = env as unknown as Env;
const now = "2026-11-06T00:00:00.000Z";
const readToken = `apo_spamread12345_${"r".repeat(43)}`;
const updateToken = `apo_spamupdate123_${"u".repeat(43)}`;
const manageToken = `apo_spammanage123_${"m".repeat(43)}`;
const bothToken = `apo_spamboth12345_${"b".repeat(43)}`;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sieve_vacation_responses"),
    env.DB.prepare("DELETE FROM sieve_runs"),
    env.DB.prepare("DELETE FROM sieve_scripts"),
    env.DB.prepare("DELETE FROM inbox_spam_rules"),
    env.DB.prepare("DELETE FROM inbox_spam_settings"),
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM idempotency_keys"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM inboxes"),
    env.DB.prepare("DELETE FROM api_keys"),
  ]);
  await env.DB.prepare(
    "INSERT INTO inboxes (id, domain, local_part, display_name, active, created_at, updated_at) VALUES ('inb_spam', 'mail.example.com', 'spam', 'Spam', 1, ?, ?)",
  ).bind(now, now).run();
  await insertKey("spamread12345", readToken, ["messages:read"]);
  await insertKey("spamupdate123", updateToken, ["messages:read", "messages:update"]);
  await insertKey("spammanage123", manageToken, ["inboxes:manage"]);
  await insertKey("spamboth12345", bothToken, ["messages:read", "messages:update", "inboxes:manage"]);
});

describe("spam migration", () => {
  it("applies additively and leaves existing rows in inbox", async () => {
    const applied = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    expect(applied.results.map((row) => row.name)).toContain("0007_message_spam.sql");
    const columns = await env.DB.prepare("PRAGMA table_info(messages)").all<{ name: string; notnull: number; dflt_value: string | null }>();
    expect(columns.results.find((column) => column.name === "folder")).toMatchObject({ notnull: 1, dflt_value: "'inbox'" });
    expect(columns.results.find((column) => column.name === "spam_score")?.notnull).toBe(0);
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('inbox_spam_settings', 'inbox_spam_rules') ORDER BY name",
    ).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual(["inbox_spam_rules", "inbox_spam_settings"]);

    await env.DB.prepare(
      `INSERT INTO messages (
        id, inbox_id, direction, envelope_from, envelope_to, subject, parse_status, agent_state,
        labels_json, headers_json, received_at, created_at, updated_at
      ) VALUES ('msg_default_folder', 'inb_spam', 'inbound', 'person@example.net', 'spam@mail.example.com', 'Hi',
        'ready', 'unprocessed', '[]', '{}', ?, ?, ?)`,
    ).bind(now, now, now).run();
    expect(await stored("msg_default_folder")).toMatchObject({
      folder: "inbox",
      spam_score: null,
      spam_verdict: null,
      spam_reasons_json: null,
    });
  });
});

describe("spam scoring during parse", () => {
  it("stores the reported pitches under the threshold and leaves a security report alone", async () => {
    await stage("msg_seal", "sales@mg.sealkeeper.run", "We tested your MCP server", "We tested your MCP server and wanted to share what we found.", "mg.sealkeeper.run");
    await stage("msg_fixter", "hello@getfixter.com", "Downtime at mcp.agentanalytics.sh", "We noticed downtime at mcp.agentanalytics.sh. Got 15 minutes to walk through it?", "getfixter.com");
    await stage("msg_yandex", "tech.carrot@yandex.ru", "Important Notice: Email Address Verification", "", "yandex.ru");
    await stage("msg_security", "researcher@example.org", "Who handles security reports?", "Hello, I found a problem in the public endpoint and need to know who handles security reports before I send the write-up.", "example.org");

    for (const id of ["msg_seal", "msg_fixter", "msg_yandex"]) {
      const row = await stored(id);
      expect(row.parse_status).toBe("ready");
      expect(row.tombstoned_at).toBeNull();
      expect(row.folder).toBe("inbox");
      expect(JSON.parse(row.labels_json)).toEqual([]);
      expect(row.spam_verdict).toBe("ham");
      expect(row.spam_score).toBeLessThan(DEFAULT_SPAM_THRESHOLD);
      expect(JSON.parse(row.spam_reasons_json ?? "[]")).not.toEqual(expect.arrayContaining([expect.stringMatching(/^auth_/)]));
      expect(JSON.parse(row.headers_json)["authentication-results"]).toMatch(/dmarc=pass/);
    }
    expect((await stored("msg_seal")).spam_score).toBe(31);
    expect((await stored("msg_fixter")).spam_score).toBe(42);
    expect((await stored("msg_yandex")).spam_score).toBe(42);
    const security = await stored("msg_security");
    expect(security.folder).toBe("inbox");
    expect(JSON.parse(security.labels_json)).toEqual([]);
    expect(security.spam_verdict).toBe("ham");
    expect(security.spam_score).toBeLessThan(DEFAULT_SPAM_THRESHOLD);
  });

  it("lets inbox settings override deployment mode and threshold", async () => {
    await setSettings("tag", 100);
    await stage("msg_threshold", "sales@mg.sealkeeper.run", "We tested your MCP server", "We tested your MCP server.", "mg.sealkeeper.run", {
      ...workerEnv,
      SPAM_FILTER: "quarantine",
      SPAM_THRESHOLD: "10",
    });
    expect(await stored("msg_threshold")).toMatchObject({ folder: "inbox", spam_verdict: "ham", labels_json: "[]" });

    await env.DB.prepare("DELETE FROM inbox_spam_settings").run();
    await setSettings("tag", null);
    await stage("msg_mode", "sales@mg.example.net", "We tested your MCP server", "We noticed a problem. Got 15 minutes?", "mg.example.net", {
      ...workerEnv,
      SPAM_FILTER: "quarantine",
      SPAM_THRESHOLD: "60",
    });
    expect(await stored("msg_mode")).toMatchObject({ folder: "inbox", spam_verdict: "spam", labels_json: '["spam"]' });

    await env.DB.prepare("DELETE FROM inbox_spam_settings").run();
    await setSettings("quarantine", null);
    await stage("msg_quarantine", "sales@mg.example.net", "We tested your MCP server", "We noticed a problem. Got 15 minutes?", "mg.example.net", workerEnv);
    expect(await stored("msg_quarantine")).toMatchObject({ folder: "spam", spam_verdict: "spam", labels_json: '["spam"]' });

    await env.DB.prepare("DELETE FROM inbox_spam_settings").run();
    await setSettings("off", null);
    await stage("msg_off", "sales@mg.example.net", "We tested your MCP server", "We noticed a problem. Got 15 minutes?", "mg.example.net", workerEnv);
    const off = await stored("msg_off");
    expect(off.folder).toBe("inbox");
    expect(off.labels_json).toBe("[]");
    expect(off.spam_verdict).toBe("spam");
    expect(off.spam_score).toBeGreaterThanOrEqual(DEFAULT_SPAM_THRESHOLD);
  });

  it("skips heuristics for an allowed sender and still accepts the delivery", async () => {
    await env.DB.prepare(
      "INSERT INTO inbox_spam_rules (inbox_id, kind, value, created_at) VALUES ('inb_spam', 'allow_sender', 'sales@mg.sealkeeper.run', ?)",
    ).bind(now).run();
    const raw = new TextEncoder().encode([
      "From: sales@mg.sealkeeper.run",
      "To: spam@mail.example.com",
      "Subject: We tested your MCP server",
      "Authentication-Results: mx.cloudflare.net; dkim=pass; spf=pass; dmarc=pass",
      "",
      "We tested your MCP server.",
    ].join("\r\n"));
    let rejected = false;
    const message: ForwardableEmailMessage = {
      from: "sales@mg.sealkeeper.run",
      to: "spam@mail.example.com",
      headers: new Headers({ "authentication-results": "mx.cloudflare.net; dkim=pass; spf=pass; dmarc=pass", subject: "We tested your MCP server" }),
      raw: new ReadableStream({ start(controller) { controller.enqueue(raw); controller.close(); } }),
      rawSize: raw.byteLength,
      setReject() { rejected = true; },
    };
    await handleInbound(message, workerEnv);
    expect(rejected).toBe(false);
    const pending = await env.DB.prepare(
      "SELECT id, raw_r2_key, headers_json FROM messages WHERE envelope_from = 'sales@mg.sealkeeper.run'",
    ).first<{ id: string; raw_r2_key: string; headers_json: string }>();
    expect(JSON.parse(pending!.headers_json)["authentication-results"]).toMatch(/dmarc=pass/);
    await parseMessage({ kind: "parse", messageId: pending!.id, rawR2Key: pending!.raw_r2_key }, workerEnv);
    const row = await stored(pending!.id);
    expect(row.spam_verdict).toBe("ham");
    expect(JSON.parse(row.spam_reasons_json ?? "[]")).toEqual(["allow_sender"]);
    expect(row.folder).toBe("inbox");
    expect(row.tombstoned_at).toBeNull();
  });
});

describe("spam folder feed and marks", () => {
  it("hides the spam folder by default and still returns it by id", async () => {
    await readyMessage("msg_in", "inbox", "2026-11-06T01:00:00.000Z");
    await readyMessage("msg_junk", "spam", "2026-11-06T02:00:00.000Z");

    const listed = await api("/v1/messages?order=asc");
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { data: Array<{ id: string; folder: string }> };
    expect(listedBody.data.map((message) => message.id)).toEqual(["msg_in"]);
    expect(listedBody.data[0]?.folder).toBe("inbox");

    const spam = await api("/v1/messages?folder=spam&order=asc");
    expect((await spam.json() as { data: Array<{ id: string }> }).data.map((message) => message.id)).toEqual(["msg_junk"]);
    const all = await api("/v1/messages?folder=all&order=asc");
    expect((await all.json() as { data: Array<{ id: string }> }).data.map((message) => message.id)).toEqual(["msg_in", "msg_junk"]);
    expect((await api("/v1/messages?folder=nope")).status).toBe(400);

    const one = await api("/v1/messages/msg_junk");
    expect(one.status).toBe(200);
    const body = await one.json() as { data: { id: string; folder: string; spam: { verdict: string | null; score: number | null; reasons: string[] } } };
    expect(body.data.id).toBe("msg_junk");
    expect(body.data.folder).toBe("spam");
    expect(body.data.spam).toEqual({ verdict: "spam", score: 80, reasons: ["cold_audit"] });
  });

  it("moves mail with mark_spam and mark_not_spam and enforces list scopes", async () => {
    await readyMessage("msg_mark", "inbox", now, "person@example.net");
    const forbidden = await api("/v1/messages/msg_mark/mark-spam", { method: "POST", body: "{}", token: readToken });
    expect(forbidden.status).toBe(403);
    expect(await stored("msg_mark")).toMatchObject({ folder: "inbox", agent_state: "unprocessed" });

    const manageOnly = await api("/v1/messages/msg_mark/mark-spam", { method: "POST", body: "{}", token: manageToken });
    expect(manageOnly.status).toBe(403);

    const blockedWithoutScope = await api("/v1/messages/msg_mark/mark-spam", {
      method: "POST",
      body: JSON.stringify({ also_block_sender: true }),
      token: updateToken,
    });
    expect(blockedWithoutScope.status).toBe(403);
    expect(await stored("msg_mark")).toMatchObject({ folder: "inbox" });
    expect(await ruleCount()).toBe(0);

    const marked = await api("/v1/messages/msg_mark/mark-spam", { method: "POST", body: "{}", token: updateToken });
    expect(marked.status).toBe(200);
    expect(await marked.json()).toMatchObject({
      data: { id: "msg_mark", folder: "spam", state: "unprocessed", labels: ["spam"], spam: { verdict: "spam", reasons: ["operator_mark"] } },
    });
    expect(await ruleCount()).toBe(0);

    const learned = await api("/v1/messages/msg_mark/mark-spam", {
      method: "POST",
      body: JSON.stringify({ also_block_sender: true, also_block_domain: true }),
      token: bothToken,
    });
    expect(learned.status).toBe(200);
    const rules = await env.DB.prepare(
      "SELECT kind, value FROM inbox_spam_rules WHERE inbox_id = 'inb_spam' ORDER BY kind",
    ).all<{ kind: string; value: string }>();
    expect(rules.results).toEqual([
      { kind: "block_domain", value: "example.net" },
      { kind: "block_sender", value: "person@example.net" },
    ]);

    await stage("msg_learned", "person@example.net", "Hello again", "Just a normal follow-up.", "example.net");
    expect(await stored("msg_learned")).toMatchObject({
      folder: "inbox",
      spam_verdict: "spam",
      labels_json: '["spam"]',
      spam_reasons_json: '["block_sender"]',
    });

    const cleared = await api("/v1/messages/msg_mark/mark-not-spam", {
      method: "POST",
      body: JSON.stringify({ also_allow_sender: true }),
      token: bothToken,
    });
    expect(cleared.status).toBe(200);
    const clearedBody = await cleared.json() as { data: { folder: string; labels: string[]; spam: { verdict: string } } };
    expect(clearedBody.data.folder).toBe("inbox");
    expect(clearedBody.data.labels).toEqual([]);
    expect(clearedBody.data.spam.verdict).toBe("ham");
    const after = await env.DB.prepare(
      "SELECT kind, value FROM inbox_spam_rules WHERE inbox_id = 'inb_spam' ORDER BY kind",
    ).all<{ kind: string; value: string }>();
    expect(after.results).toEqual([
      { kind: "allow_sender", value: "person@example.net" },
      { kind: "block_domain", value: "example.net" },
    ]);
    expect((await stored("msg_mark")).agent_state).toBe("unprocessed");
  });

  it("hides spam in poll_messages and rejects a list edit without inboxes:manage", async () => {
    await readyMessage("msg_visible", "inbox", "2026-11-06T01:00:00.000Z");
    await readyMessage("msg_hidden", "spam", "2026-11-06T02:00:00.000Z");

    const polled = await rpc(readToken, "tools/call", { name: "poll_messages", arguments: { state: "unprocessed", limit: 25 } });
    expect(messageIds(polled)).toEqual(["msg_visible"]);
    const all = await rpc(readToken, "tools/call", { name: "poll_messages", arguments: { folder: "all", state: "unprocessed" } });
    expect(messageIds(all)).toEqual(["msg_visible", "msg_hidden"]);
    const one = await rpc(readToken, "tools/call", { name: "get_message", arguments: { message_id: "msg_hidden" } });
    const fetched = toolData(one) as { folder: string; spam: { verdict: string; score: number } };
    expect(fetched.folder).toBe("spam");
    expect(fetched.spam).toMatchObject({ verdict: "spam", score: 80 });

    const denied = await rpc(updateToken, "tools/call", {
      name: "mark_spam",
      arguments: { message_id: "msg_visible", also_block_sender: true },
    });
    expect(denied.result?.isError).toBe(true);
    expect(denied.result?.content?.[0]?.text).toContain("insufficient_scope");
    expect(await stored("msg_visible")).toMatchObject({ folder: "inbox" });
    expect(await ruleCount()).toBe(0);

    const marked = await rpc(bothToken, "tools/call", {
      name: "mark_not_spam",
      arguments: { message_id: "msg_hidden", also_allow_domain: true },
    });
    expect(marked.result?.isError).not.toBe(true);
    expect(await stored("msg_hidden")).toMatchObject({ folder: "inbox", spam_verdict: "ham" });
    const rules = await env.DB.prepare(
      "SELECT kind, value FROM inbox_spam_rules WHERE inbox_id = 'inb_spam'",
    ).all<{ kind: string; value: string }>();
    expect(rules.results).toEqual([{ kind: "allow_domain", value: "example.net" }]);
  });

  it("walks folder=all with a cursor and does not skip or repeat mixed mail", async () => {
    await readyMessage("msg_page_a", "inbox", "2026-11-06T01:00:00.000Z");
    await readyMessage("msg_page_b", "spam", "2026-11-06T01:00:00.000Z");
    await readyMessage("msg_page_c", "inbox", "2026-11-06T02:00:00.000Z");
    await readyMessage("msg_page_d", "spam", "2026-11-06T03:00:00.000Z");
    await readyMessage("msg_page_e", "inbox", "2026-11-06T04:00:00.000Z");

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const path = `/v1/messages?folder=all&order=asc&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await api(path);
      expect(response.status).toBe(200);
      const body = await response.json() as { data: Array<{ id: string }>; next_cursor: string | null };
      seen.push(...body.data.map((row) => row.id));
      if (!body.next_cursor) {
        expect(page).toBe(2);
        expect(body.data).toHaveLength(1);
        break;
      }
      expect(body.data).toHaveLength(2);
      cursor = body.next_cursor;
    }
    expect(seen).toEqual(["msg_page_a", "msg_page_b", "msg_page_c", "msg_page_d", "msg_page_e"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("treats a repeated spam mark as the same state and moves not-spam back once", async () => {
    await readyMessage("msg_idem", "inbox", now, "person@example.net");
    const first = await api("/v1/messages/msg_idem/mark-spam", { method: "POST", body: "{}", token: updateToken });
    const firstBody = await first.json();
    const second = await api("/v1/messages/msg_idem/mark-spam", { method: "POST", body: "{}", token: updateToken });
    expect(await second.json()).toEqual(firstBody);
    expect(JSON.parse((await stored("msg_idem")).spam_reasons_json ?? "[]").filter((reason: string) => reason === "operator_mark")).toEqual(["operator_mark"]);
    expect(await ruleCount()).toBe(0);

    await api("/v1/messages/msg_idem/mark-spam", {
      method: "POST",
      body: JSON.stringify({ also_block_sender: true }),
      token: bothToken,
    });
    await api("/v1/messages/msg_idem/mark-spam", {
      method: "POST",
      body: JSON.stringify({ also_block_sender: true }),
      token: bothToken,
    });
    const rules = await env.DB.prepare(
      "SELECT kind, value FROM inbox_spam_rules WHERE inbox_id = 'inb_spam'",
    ).all<{ kind: string; value: string }>();
    expect(rules.results).toEqual([{ kind: "block_sender", value: "person@example.net" }]);
    expect(await stored("msg_idem")).toMatchObject({ folder: "spam", spam_verdict: "spam" });

    const cleared = await api("/v1/messages/msg_idem/mark-not-spam", { method: "POST", body: "{}", token: updateToken });
    const clearedBody = await cleared.json() as { data: { folder: string; labels: string[]; spam: { verdict: string } } };
    expect(clearedBody.data.folder).toBe("inbox");
    expect(clearedBody.data.labels).toEqual([]);
    expect(clearedBody.data.spam.verdict).toBe("ham");
    const clearedAgain = await api("/v1/messages/msg_idem/mark-not-spam", { method: "POST", body: "{}", token: updateToken });
    expect(await clearedAgain.json()).toEqual(clearedBody);
    expect(await stored("msg_idem")).toMatchObject({ folder: "inbox", spam_verdict: "ham" });
    const remaining = await env.DB.prepare(
      "SELECT kind, value FROM inbox_spam_rules WHERE inbox_id = 'inb_spam'",
    ).all<{ kind: string; value: string }>();
    expect(remaining.results).toEqual([{ kind: "block_sender", value: "person@example.net" }]);
  });
});

describe("spam does not send or drop mail", () => {
  it.each(["tag", "quarantine"] as const)("sends no vacation reply and does not reject %s mail", async (mode) => {
    await setSettings(mode, 60);
    await env.DB.prepare(
      "INSERT INTO inbox_spam_rules (inbox_id, kind, value, created_at) VALUES ('inb_spam', 'block_sender', 'person@example.net', ?)",
    ).bind(now).run();
    await installVacation();
    const delivered = await deliver("person@example.net", "Hello", "Hi there.");
    expect(delivered.rejected).toBe(false);

    const queueSend = vi.fn(async () => undefined);
    await parseMessage(
      { kind: "parse", messageId: delivered.id, rawR2Key: delivered.rawKey },
      { ...workerEnv, AUTOMATION_QUEUE: { send: queueSend } as unknown as Env["AUTOMATION_QUEUE"] },
    );
    expect(queueSend).not.toHaveBeenCalled();
    const row = await stored(delivered.id);
    expect(row.parse_status).toBe("ready");
    expect(row.tombstoned_at).toBeNull();
    expect(row.spam_verdict).toBe("spam");
    expect(row.labels_json).toContain("spam");
    expect(row.folder).toBe(mode === "quarantine" ? "spam" : "inbox");
    expect(await env.MAIL_BUCKET.get(delivered.rawKey)).not.toBeNull();

    const emailSend = vi.fn(async () => ({ messageId: "provider-auto" }));
    await executeAutomationTask(
      { kind: "automate", messageId: delivered.id, scriptId: "siv_away", scriptRevision: 1 },
      { ...workerEnv, EMAIL: { send: emailSend } as unknown as Env["EMAIL"] },
    );
    expect(emailSend).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sieve_runs").first()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE direction = 'outbound'").first()).toEqual({ count: 0 });
  });

  it("stores a score in off mode and still runs Sieve", async () => {
    await setSettings("off", 60);
    await env.DB.prepare(
      "INSERT INTO inbox_spam_rules (inbox_id, kind, value, created_at) VALUES ('inb_spam', 'block_sender', 'person@example.net', ?)",
    ).bind(now).run();
    await installVacation();
    const delivered = await deliver("person@example.net", "Hello", "Hi there.");
    expect(delivered.rejected).toBe(false);
    const queueSend = vi.fn(async () => undefined);
    await parseMessage(
      { kind: "parse", messageId: delivered.id, rawR2Key: delivered.rawKey },
      { ...workerEnv, AUTOMATION_QUEUE: { send: queueSend } as unknown as Env["AUTOMATION_QUEUE"] },
    );
    expect(queueSend).toHaveBeenCalledOnce();
    const row = await stored(delivered.id);
    expect(row).toMatchObject({
      folder: "inbox",
      labels_json: "[]",
      spam_verdict: "spam",
      parse_status: "ready",
      tombstoned_at: null,
    });
    expect(row.spam_score).toBeGreaterThanOrEqual(DEFAULT_SPAM_THRESHOLD);
    const emailSend = vi.fn(async () => ({ messageId: "provider-off" }));
    await executeAutomationTask(
      { kind: "automate", messageId: delivered.id, scriptId: "siv_away", scriptRevision: 1 },
      { ...workerEnv, EMAIL: { send: emailSend } as unknown as Env["EMAIL"] },
    );
    expect(emailSend).toHaveBeenCalledOnce();
  });

  it("keeps the message and still queues Sieve when scoring throws", async () => {
    await installVacation();
    const id = "msg_failopen";
    const rawKey = `messages/inb_spam/${id}/raw.eml`;
    await env.MAIL_BUCKET.put(rawKey, "From: person@example.net\r\nTo: spam@mail.example.com\r\nSubject: Hello\r\n\r\nHi there.");
    await env.DB.prepare(
      `INSERT INTO messages (
        id, inbox_id, direction, envelope_from, envelope_to, subject, raw_r2_key, parse_status, agent_state,
        labels_json, headers_json, received_at, created_at, updated_at
      ) VALUES (?, 'inb_spam', 'inbound', 'person@example.net', 'spam@mail.example.com', 'Hello', ?, 'pending', 'unprocessed', '[]', '{}', ?, ?, ?)`,
    ).bind(id, rawKey, now, now, now).run();
    const queueSend = vi.fn(async () => undefined);
    const database = env.DB;
    await parseMessage(
      { kind: "parse", messageId: id, rawR2Key: rawKey },
      {
        ...workerEnv,
        AUTOMATION_QUEUE: { send: queueSend } as unknown as Env["AUTOMATION_QUEUE"],
        DB: {
          prepare(sql: string) {
            if (sql.includes("inbox_spam_")) throw new Error("D1_ERROR: scorer backend failed");
            return database.prepare(sql);
          },
          batch: database.batch.bind(database),
          exec: database.exec.bind(database),
        },
      } as Env,
    );
    const row = await stored(id);
    expect(row).toMatchObject({
      folder: "inbox",
      labels_json: "[]",
      spam_verdict: null,
      spam_score: null,
      parse_status: "ready",
      tombstoned_at: null,
    });
    expect(await env.MAIL_BUCKET.get(rawKey)).not.toBeNull();
    expect(queueSend).toHaveBeenCalledOnce();
  });
});

async function insertKey(keyId: string, token: string, scopes: string[]): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO api_keys (key_id, digest_sha256, label, scopes_json, created_at) VALUES (?, ?, 'spam', ?, ?)",
  ).bind(keyId, await sha256Hex(token), JSON.stringify(scopes), now).run();
}

async function setSettings(mode: string, threshold: number | null): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO inbox_spam_settings (inbox_id, mode, threshold, updated_at) VALUES ('inb_spam', ?, ?, ?)",
  ).bind(mode, threshold, now).run();
}

async function stage(
  id: string,
  from: string,
  subject: string,
  text: string,
  authDomain: string,
  executionEnv: Env = workerEnv,
): Promise<void> {
  const raw = [
    `From: ${from}`,
    "To: spam@mail.example.com",
    `Subject: ${subject}`,
    `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=${authDomain}; spf=pass; dmarc=pass header.from=${authDomain}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
  ].join("\r\n");
  const key = `messages/inb_spam/${id}/raw.eml`;
  await env.MAIL_BUCKET.put(key, raw);
  await env.DB.prepare(
    `INSERT INTO messages (
      id, inbox_id, direction, envelope_from, envelope_to, subject, raw_r2_key, parse_status, agent_state,
      labels_json, headers_json, received_at, created_at, updated_at
    ) VALUES (?, 'inb_spam', 'inbound', ?, 'spam@mail.example.com', ?, ?, 'pending', 'unprocessed', '[]', '{}', ?, ?, ?)`,
  ).bind(id, from, subject, key, now, now, now).run();
  await parseMessage({ kind: "parse", messageId: id, rawR2Key: key }, executionEnv);
}

async function readyMessage(id: string, folder: "inbox" | "spam", receivedAt: string, from = "person@example.net"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages (
      id, inbox_id, direction, envelope_from, envelope_to, subject, text_excerpt, parse_status, agent_state,
      labels_json, headers_json, received_at, created_at, updated_at
    ) VALUES (?, 'inb_spam', 'inbound', ?, 'spam@mail.example.com', 'Hello', 'Body', 'ready', 'unprocessed', '[]', '{}', ?, ?, ?)`,
  ).bind(id, from, receivedAt, receivedAt, receivedAt).run();
  if (folder === "spam") {
    await env.DB.prepare(
      "UPDATE messages SET folder = 'spam', spam_score = 80, spam_reasons_json = ?, spam_verdict = 'spam' WHERE id = ?",
    ).bind(JSON.stringify(["cold_audit"]), id).run();
  }
}

async function stored(id: string): Promise<{
  folder: string;
  labels_json: string;
  spam_score: number | null;
  spam_reasons_json: string | null;
  spam_verdict: string | null;
  parse_status: string;
  headers_json: string;
  tombstoned_at: string | null;
  agent_state: string;
}> {
  const row = await env.DB.prepare(
    `SELECT folder, labels_json, spam_score, spam_reasons_json, spam_verdict, parse_status, headers_json, tombstoned_at, agent_state
     FROM messages WHERE id = ?`,
  ).bind(id).first<{
    folder: string;
    labels_json: string;
    spam_score: number | null;
    spam_reasons_json: string | null;
    spam_verdict: string | null;
    parse_status: string;
    headers_json: string;
    tombstoned_at: string | null;
    agent_state: string;
  }>();
  if (!row) throw new Error(`missing message ${id}`);
  return row;
}

const vacationSource = `
require ["envelope", "vacation"];
if envelope :is "to" "spam@mail.example.com" {
  vacation :days 1 :subject "Away" "Out of office.";
  stop;
}`;

async function installVacation(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sieve_scripts
      (id, inbox_id, name, revision, source, compiled_ir_json, source_sha256, active, created_at, updated_at)
     VALUES ('siv_away', 'inb_spam', 'Away', 1, ?, '{}', ?, 1, ?, ?)`,
  ).bind(vacationSource, "c".repeat(64), now, now).run();
}

async function deliver(from: string, subject: string, text: string): Promise<{ id: string; rawKey: string; rejected: boolean }> {
  const raw = new TextEncoder().encode([
    `From: ${from}`,
    "To: spam@mail.example.com",
    `Subject: ${subject}`,
    "",
    text,
  ].join("\r\n"));
  let rejected = false;
  await handleInbound({
    from,
    to: "spam@mail.example.com",
    headers: new Headers({ subject }),
    raw: new ReadableStream({ start(controller) { controller.enqueue(raw); controller.close(); } }),
    rawSize: raw.byteLength,
    setReject() { rejected = true; },
  }, workerEnv);
  const pending = await env.DB.prepare(
    "SELECT id, raw_r2_key FROM messages WHERE envelope_from = ?",
  ).bind(from).first<{ id: string; raw_r2_key: string }>();
  if (!pending) throw new Error("inbound message was not stored");
  return { id: pending.id, rawKey: pending.raw_r2_key, rejected };
}

async function ruleCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM inbox_spam_rules").first<{ count: number }>();
  return row?.count ?? 0;
}

function api(path: string, init: { method?: string; body?: string; token?: string } = {}): Promise<Response> {
  return handleApi(new Request(`https://worker.example${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${init.token ?? bothToken}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body,
  }), workerEnv);
}

function rpc(token: string, method: string, params: Record<string, unknown>): Promise<{
  result?: { isError?: boolean; content?: Array<{ text: string }> };
}> {
  return handleApi(new Request("https://worker.example/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }), workerEnv).then(async (response) => response.json() as Promise<{
    result?: { isError?: boolean; content?: Array<{ text: string }> };
  }>);
}

function toolData(response: { result?: { content?: Array<{ text: string }> } }): unknown {
  const text = response.result?.content?.[0]?.text ?? "";
  return (JSON.parse(text) as { data: unknown }).data;
}

function messageIds(response: { result?: { content?: Array<{ text: string }> } }): string[] {
  const payload = toolData(response) as { data: Array<{ id: string }> };
  return payload.data.map((message) => message.id);
}
