import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleApi } from "../src/api.js";
import { handleInbound, type ForwardableEmailMessage } from "../src/inbound.js";
import { parseMessage } from "../src/queue.js";
import {
  BAYES_CAP,
  signalProbability,
  spamLearnEnabled,
  tokenizeMessage,
} from "../src/spam-bayes.js";
import { AUTH_FAILURE_WEIGHTS, scoreSpam, type SpamLists } from "../src/spam.js";
import type { Env } from "../src/types.js";
import { sha256Hex } from "../src/util.js";

const workerEnv = env as unknown as Env;
const learnEnv: Env = { ...workerEnv, SPAM_LEARN: "on" };
const now = "2026-11-06T00:00:00.000Z";
const updateToken = `apo_learnupdate1_${"u".repeat(43)}`;
const readToken = `apo_learnread123_${"r".repeat(43)}`;
const EMPTY_LISTS: SpamLists = { allowSenders: [], blockSenders: [], allowDomains: [], blockDomains: [] };
const SPAM_FROM = "person@spammy.test";
const HAM_FROM = "person@weekly.test";
const SPAM_SUBJECT = "prizewinner wiretransfer limitedoffer";
const HAM_SUBJECT = "weeklystatus standupnotes shipnotes";
const SPAM_TEXT = "Please review this note.";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM message_spam_training"),
    env.DB.prepare("DELETE FROM inbox_spam_token_counts"),
    env.DB.prepare("DELETE FROM inbox_spam_class_counts"),
    env.DB.prepare("DELETE FROM inbox_spam_rules"),
    env.DB.prepare("DELETE FROM inbox_spam_settings"),
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM inboxes"),
    env.DB.prepare("DELETE FROM api_keys"),
  ]);
  await env.DB.prepare(
    "INSERT INTO inboxes (id, domain, local_part, display_name, active, created_at, updated_at) VALUES ('inb_spam', 'mail.example.com', 'spam', 'Spam', 1, ?, ?)",
  ).bind(now, now).run();
  await env.DB.prepare(
    "INSERT INTO inboxes (id, domain, local_part, display_name, active, created_at, updated_at) VALUES ('inb_other', 'mail.example.com', 'other', 'Other', 1, ?, ?)",
  ).bind(now, now).run();
  await insertKey("learnupdate1", updateToken, ["messages:read", "messages:update"]);
  await insertKey("learnread123", readToken, ["messages:read"]);
});

describe("spam learning gate", () => {
  it("keeps the rules score byte-for-byte when SPAM_LEARN is off, even with trained counts", async () => {
    expect(spamLearnEnabled(workerEnv)).toBe(false);
    await seedExtremeModel("inb_spam");
    await stage("msg_off", "inb_spam", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, "spammy.test", workerEnv);
    const row = await stored("msg_off");
    const expected = scoreSpam(rulesInput(SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, passingAuth("spammy.test")));
    expect(JSON.stringify({
      score: row.spam_score,
      reasons: JSON.parse(row.spam_reasons_json ?? "[]"),
      verdict: row.spam_verdict,
    })).toBe(JSON.stringify(expected));
    expect(row.folder).toBe("inbox");
    expect(row.labels_json).toBe("[]");
    expect(JSON.parse(row.spam_reasons_json ?? "[]").some((reason: string) => String(reason).startsWith("bayes_"))).toBe(false);

    await ready("msg_mark_off", "inb_spam", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT);
    const marked = await api("/v1/messages/msg_mark_off/mark-spam", { method: "POST", body: "{}" }, workerEnv);
    expect(marked.status).toBe(200);
    expect(await trainingCount()).toBe(0);
    expect(await classCounts("inb_spam")).toEqual({ spam_messages: 40, ham_messages: 40 });
  });

  it("stays cold below N, learns after N marks, and keeps inboxes apart", async () => {
    await markClass("spam", "s", 19);
    await markClass("ham", "h", 19);
    await stage("msg_cold", "inb_spam", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, "spammy.test", learnEnv);
    const cold = await stored("msg_cold");
    const rules = scoreSpam(rulesInput(SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, passingAuth("spammy.test")));
    expect(JSON.stringify({
      score: cold.spam_score,
      reasons: JSON.parse(cold.spam_reasons_json ?? "[]"),
      verdict: cold.spam_verdict,
    })).toBe(JSON.stringify(rules));

    await markClass("spam", "s2", 1);
    await markClass("ham", "h2", 1);
    expect(await classCounts("inb_spam")).toEqual({ spam_messages: 20, ham_messages: 20 });
    await stage("msg_learned", "inb_spam", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, "spammy.test", learnEnv);
    const learned = await stored("msg_learned");
    expect(learned.spam_score).toBe(BAYES_CAP);
    expect(learned.spam_verdict).toBe("ham");
    expect(learned.folder).toBe("inbox");
    expect(JSON.parse(learned.labels_json)).toEqual([]);
    expect(JSON.parse(learned.spam_reasons_json ?? "[]")).toEqual([expect.stringMatching(/^bayes_spam_(?:0\.\d{2}|1\.00)$/)]);

    await stage("msg_auth", "inb_spam", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, "spammy.test", learnEnv, "dmarc=fail");
    const withAuth = await stored("msg_auth");
    expect(withAuth.spam_score).toBe(BAYES_CAP + AUTH_FAILURE_WEIGHTS.auth_dmarc_fail);
    expect(withAuth.spam_verdict).toBe("spam");
    expect(withAuth.folder).toBe("inbox");
    expect(JSON.parse(withAuth.labels_json)).toEqual(["spam"]);

    await stage("msg_other", "inb_other", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, "spammy.test", learnEnv);
    const other = await stored("msg_other");
    expect(JSON.stringify({
      score: other.spam_score,
      reasons: JSON.parse(other.spam_reasons_json ?? "[]"),
      verdict: other.spam_verdict,
    })).toBe(JSON.stringify(rules));
    expect(await classCounts("inb_other")).toEqual({ spam_messages: 0, ham_messages: 0 });
    expect(await trainingCountFor("inb_other")).toBe(0);
  });

  it("counts a mark once and moves the counts on a flip", async () => {
    const oneEnv: Env = { ...workerEnv, SPAM_LEARN: "on", SPAM_LEARN_MIN: "1" };
    await ready("msg_once", "inb_spam", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT);
    const first = await api("/v1/messages/msg_once/mark-spam", { method: "POST", body: "{}" }, oneEnv);
    const firstBody = await first.json();
    const second = await api("/v1/messages/msg_once/mark-spam", { method: "POST", body: "{}" }, oneEnv);
    expect(await second.json()).toEqual(firstBody);
    expect(await classCounts("inb_spam")).toEqual({ spam_messages: 1, ham_messages: 0 });
    expect(await trainingCount()).toBe(1);
    const spamCounts = await tokenCounts("inb_spam");
    expect(spamCounts.length).toBeGreaterThan(0);
    for (const row of spamCounts) expect(row).toMatchObject({ spam_count: 1, ham_count: 0 });

    const cleared = await api("/v1/messages/msg_once/mark-not-spam", { method: "POST", body: "{}" }, oneEnv);
    const clearedBody = await cleared.json() as { data: { folder: string; spam: { verdict: string } } };
    expect(clearedBody.data).toMatchObject({
      folder: "inbox",
      spam: { verdict: "ham" },
    });
    const clearedAgain = await api("/v1/messages/msg_once/mark-not-spam", { method: "POST", body: "{}" }, oneEnv);
    expect(await clearedAgain.json()).toEqual(clearedBody);
    expect(await classCounts("inb_spam")).toEqual({ spam_messages: 0, ham_messages: 1 });
    expect(await trainingCount()).toBe(1);
    for (const row of await tokenCounts("inb_spam")) {
      expect(row.spam_count).toBe(0);
      expect(row.ham_count).toBe(1);
    }

    await api("/v1/messages/msg_once/mark-spam", { method: "POST", body: "{}" }, oneEnv);
    expect(await classCounts("inb_spam")).toEqual({ spam_messages: 1, ham_messages: 0 });
    expect(await trainingCount()).toBe(1);
    for (const row of await tokenCounts("inb_spam")) {
      expect(row.spam_count).toBeGreaterThanOrEqual(0);
      expect(row.ham_count).toBeGreaterThanOrEqual(0);
      expect(row).toMatchObject({ spam_count: 1, ham_count: 0 });
    }
  });

  it("keeps the rules score when the classifier fails and still accepts the mail", async () => {
    const database = env.DB;
    const raw = [
      "From: sales@mg.example.net",
      "To: spam@mail.example.com",
      "Subject: We tested your MCP server",
      "Authentication-Results: mx.cloudflare.net; dkim=pass; spf=pass; dmarc=pass",
      "",
      "We noticed a problem. Got 15 minutes?",
    ].join("\r\n");
    const bytes = new TextEncoder().encode(raw);
    let rejected = false;
    await handleInbound({
      from: "sales@mg.example.net",
      to: "spam@mail.example.com",
      headers: new Headers({ subject: "We tested your MCP server" }),
      raw: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      rawSize: bytes.byteLength,
      setReject() { rejected = true; },
    } satisfies ForwardableEmailMessage, learnEnv);
    expect(rejected).toBe(false);
    const pending = await env.DB.prepare(
      "SELECT id, raw_r2_key FROM messages WHERE envelope_from = 'sales@mg.example.net'",
    ).first<{ id: string; raw_r2_key: string }>();
    expect(pending).toBeTruthy();
    await parseMessage({ kind: "parse", messageId: pending!.id, rawR2Key: pending!.raw_r2_key }, {
      ...learnEnv,
      DB: {
        prepare(sql: string) {
          if (sql.includes("inbox_spam_token_counts") || sql.includes("inbox_spam_class_counts")) {
            throw new Error("D1_ERROR: classifier backend failed");
          }
          return database.prepare(sql);
        },
        batch: database.batch.bind(database),
        exec: database.exec.bind(database),
      },
    } as Env);
    const row = await stored(pending!.id);
    const expected = scoreSpam(rulesInput(
      "sales@mg.example.net",
      "We tested your MCP server",
      "We noticed a problem. Got 15 minutes?",
      "mx.cloudflare.net; dkim=pass; spf=pass; dmarc=pass",
    ));
    expect(row.parse_status).toBe("ready");
    expect(row.tombstoned_at).toBeNull();
    expect(JSON.stringify({
      score: row.spam_score,
      reasons: JSON.parse(row.spam_reasons_json ?? "[]"),
      verdict: row.spam_verdict,
    })).toBe(JSON.stringify(expected));
    expect(expected.score).toBeGreaterThan(0);
    expect(JSON.parse(row.spam_reasons_json ?? "[]").some((reason: string) => String(reason).startsWith("bayes_"))).toBe(false);
  });

  it("shows training counts on the same scope as the mark tools", async () => {
    const denied = await api("/v1/inboxes/inb_spam/spam-training", {}, workerEnv, readToken);
    expect(denied.status).toBe(403);
    const empty = await api("/v1/inboxes/inb_spam/spam-training", {}, learnEnv, updateToken);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      data: {
        inbox_id: "inb_spam",
        spam_messages: 0,
        ham_messages: 0,
        tokens: 0,
        min_marks: 20,
        learning: true,
        ready: false,
      },
    });
    expect((await api("/v1/inboxes/inb_missing/spam-training", {}, learnEnv, updateToken)).status).toBe(404);

    const oneEnv: Env = { ...workerEnv, SPAM_LEARN: "on", SPAM_LEARN_MIN: "1" };
    await ready("msg_seen", "inb_spam", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT);
    await api("/v1/messages/msg_seen/mark-spam", { method: "POST", body: "{}" }, oneEnv);
    const seen = await api("/v1/inboxes/inb_spam/spam-training", {}, oneEnv, updateToken);
    expect(seen.status).toBe(200);
    const body = await seen.json() as { data: { spam_messages: number; ham_messages: number; tokens: number; ready: boolean; learning: boolean; min_marks: number } };
    expect(body.data).toMatchObject({ spam_messages: 1, ham_messages: 0, learning: true, min_marks: 1, ready: false });
    expect(body.data.tokens).toBeGreaterThan(0);

    const rpcResult = await rpc(updateToken, "get_spam_training", { inbox_id: "inb_spam" }, oneEnv);
    expect(rpcResult.result?.isError).not.toBe(true);
    const tool = JSON.parse(rpcResult.result?.content?.[0]?.text ?? "{}") as { data: { spam_messages: number; tokens: number } };
    expect(tool.data.spam_messages).toBe(1);
    expect(tool.data.tokens).toBe(body.data.tokens);
  });

  it("classifies a bounded message inside a small worker CPU budget", () => {
    const tokens = tokenizeMessage({ subject: SPAM_SUBJECT, text: "Please review this note.", from: SPAM_FROM });
    const model = {
      spamMessages: 20,
      hamMessages: 20,
      tokens: new Map(tokens.map((token) => [token, { spam: 20, ham: 0 }])),
    };
    const started = performance.now();
    const iterations = 100;
    for (let index = 0; index < iterations; index += 1) {
      const text = `${"alpha ".repeat(700)}prizewinner wiretransfer limitedoffer`;
      const messageTokens = tokenizeMessage({ subject: SPAM_SUBJECT, text, from: `person${index}@spammy.test` });
      const probability = signalProbability(model, messageTokens, 20);
      scoreSpam(rulesInput(SPAM_FROM, SPAM_SUBJECT, text.slice(0, 4_000), null, { spamProbability: probability }));
    }
    const perMessage = (performance.now() - started) / iterations;
    console.log(`bayes_worker_cpu_ms=${perMessage.toFixed(4)}`);
    expect(perMessage, `bayes_worker_cpu_ms=${perMessage.toFixed(4)}`).toBeLessThan(5);
  });
});

describe("spam training backfill", () => {
  it("trains existing marks once, keeps a flip's final class, and does not double-count a later live mark", async () => {
    await markOff("msg_bf_spam", "inb_spam", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, true);
    await markOff("msg_bf_ham", "inb_spam", HAM_FROM, HAM_SUBJECT, "A weekly note.", false);
    await markOff("msg_bf_flip", "inb_spam", SPAM_FROM, "old prizewinner wiretransfer", SPAM_TEXT, true);
    expect((await api("/v1/messages/msg_bf_flip/mark-not-spam", { method: "POST", body: "{}" }, workerEnv)).status).toBe(200);
    await markOff("msg_bf_other", "inb_other", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, true);
    await ready("msg_bf_auto", "inb_spam", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT);
    await env.DB.prepare(
      "UPDATE messages SET folder = 'spam', spam_verdict = 'spam', spam_reasons_json = ? WHERE id = 'msg_bf_auto'",
    ).bind(JSON.stringify(["cold_audit"])).run();
    await markOff("msg_bf_mismatch", "inb_spam", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, true);
    await env.DB.prepare("UPDATE messages SET folder = 'inbox' WHERE id = 'msg_bf_mismatch'").run();
    expect(await trainingCount()).toBe(0);

    const denied = await api("/v1/inboxes/inb_spam/spam-training", { method: "POST", body: "{}" }, learnEnv, readToken);
    expect(denied.status).toBe(403);
    expect((await api("/v1/inboxes/inb_missing/spam-training", { method: "POST", body: "{}" }, learnEnv)).status).toBe(404);
    expect((await api("/v1/inboxes/inb_spam/spam-training", { method: "POST", body: JSON.stringify({ limit: 101 }) }, learnEnv)).status).toBe(400);

    const first = await backfill();
    expect(first).toMatchObject({ inbox_id: "inb_spam", trained: 3, unchanged: 0, skipped: 0, done: true, next_cursor: null });
    expect(await classCounts("inb_spam")).toEqual({ spam_messages: 1, ham_messages: 2 });
    expect(await trainingLabel("msg_bf_spam")).toBe("spam");
    expect(await trainingLabel("msg_bf_ham")).toBe("ham");
    expect(await trainingLabel("msg_bf_flip")).toBe("ham");
    expect(await trainingLabel("msg_bf_other")).toBeNull();
    expect(await trainingLabel("msg_bf_auto")).toBeNull();
    expect(await trainingLabel("msg_bf_mismatch")).toBeNull();
    expect(await classCounts("inb_other")).toBeNull();

    const again = await backfill();
    expect(again).toMatchObject({ trained: 0, unchanged: 3, skipped: 0, done: true });
    expect(await classCounts("inb_spam")).toEqual({ spam_messages: 1, ham_messages: 2 });
    expect(await trainingCount()).toBe(3);

    const oneEnv: Env = { ...workerEnv, SPAM_LEARN: "on", SPAM_LEARN_MIN: "1" };
    expect((await api("/v1/messages/msg_bf_spam/mark-spam", { method: "POST", body: "{}" }, oneEnv)).status).toBe(200);
    expect(await classCounts("inb_spam")).toEqual({ spam_messages: 1, ham_messages: 2 });
    await markLive("msg_bf_later", true, oneEnv);
    expect(await classCounts("inb_spam")).toEqual({ spam_messages: 2, ham_messages: 2 });
    expect((await api("/v1/messages/msg_bf_later/mark-not-spam", { method: "POST", body: "{}" }, oneEnv)).status).toBe(200);
    expect(await classCounts("inb_spam")).toEqual({ spam_messages: 1, ham_messages: 3 });
    expect(await trainingCount()).toBe(4);

    const tool = await rpc(updateToken, "backfill_spam_training", { inbox_id: "inb_spam", limit: 10 }, oneEnv);
    expect(tool.result?.isError).not.toBe(true);
    const toolBody = JSON.parse(tool.result?.content?.[0]?.text ?? "{}") as { data: { trained: number; unchanged: number } };
    expect(toolBody.data.trained).toBe(0);
    expect(toolBody.data.unchanged).toBe(4);
    expect(await classCounts("inb_spam")).toEqual({ spam_messages: 1, ham_messages: 3 });
  });

  it("pages marked rows and leaves a second full pass unchanged", async () => {
    await markOff("msg_page_a", "inb_spam", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, true);
    await markOff("msg_page_b", "inb_spam", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, true);
    await markOff("msg_page_c", "inb_spam", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, true);
    const seen: string[] = [];
    let cursor: string | null = null;
    let trained = 0;
    for (let page = 0; page < 5; page += 1) {
      const body = await backfill(cursor ? { limit: 1, cursor } : { limit: 1 });
      trained += body.trained;
      if (body.next_cursor) seen.push(body.next_cursor);
      cursor = body.next_cursor;
      if (body.done) break;
    }
    expect(trained).toBe(3);
    expect(seen).toEqual(["msg_page_a", "msg_page_b", "msg_page_c"]);
    expect(await classCounts("inb_spam")).toEqual({ spam_messages: 3, ham_messages: 0 });
    const again = await backfill();
    expect(again).toMatchObject({ trained: 0, unchanged: 3, skipped: 0, done: true });
    expect(await classCounts("inb_spam")).toEqual({ spam_messages: 3, ham_messages: 0 });
  });

  it("skips an unreadable message and reads a truncated body from the raw object", async () => {
    await markOff("msg_bf_ok", "inb_spam", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, true);
    await markOff("msg_bf_bad", "inb_spam", HAM_FROM, HAM_SUBJECT, "gone", false);
    await env.DB.prepare(
      "UPDATE messages SET text_excerpt = NULL, body_truncated = 1, raw_r2_key = 'missing/raw.eml' WHERE id = 'msg_bf_bad'",
    ).run();
    await markOff("msg_bf_raw", "inb_spam", SPAM_FROM, "plain subject", "short", true);
    const rawKey = "messages/inb_spam/msg_bf_raw/raw.eml";
    await env.MAIL_BUCKET.put(rawKey, [
      "From: person@spammy.test",
      "To: spam@mail.example.com",
      "Subject: plain subject",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "rawbodytoken",
    ].join("\r\n"));
    await env.DB.prepare(
      "UPDATE messages SET text_excerpt = NULL, body_truncated = 1, raw_r2_key = ? WHERE id = 'msg_bf_raw'",
    ).bind(rawKey).run();

    const page = await backfill();
    expect(page.status ?? 200).toBe(200);
    expect(page).toMatchObject({ trained: 2, unchanged: 0, skipped: 1, done: true });
    expect(await trainingLabel("msg_bf_ok")).toBe("spam");
    expect(await trainingLabel("msg_bf_bad")).toBeNull();
    expect(await trainingLabel("msg_bf_raw")).toBe("spam");
    expect(await tokenCounts("inb_spam")).toContainEqual(expect.objectContaining({ token: "rawbodytoken", spam_count: 1, ham_count: 0 }));
    expect(await classCounts("inb_spam")).toEqual({ spam_messages: 2, ham_messages: 0 });

    const again = await backfill();
    expect(again).toMatchObject({ trained: 0, unchanged: 2, skipped: 1 });
    expect(await classCounts("inb_spam")).toEqual({ spam_messages: 2, ham_messages: 0 });
    expect(await trainingLabel("msg_bf_bad")).toBeNull();
  });

  it("does not backfill or change the rules score while SPAM_LEARN is off", async () => {
    await markOff("msg_bf_off", "inb_spam", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, true);
    expect(await trainingCount()).toBe(0);
    await stage("msg_off_backfill", "inb_spam", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, "spammy.test", workerEnv);
    expect(await trainingCount()).toBe(0);
    const before = await stored("msg_off_backfill");
    const expected = scoreSpam(rulesInput(SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, passingAuth("spammy.test")));
    expect(JSON.stringify({
      score: before.spam_score,
      reasons: JSON.parse(before.spam_reasons_json ?? "[]"),
      verdict: before.spam_verdict,
    })).toBe(JSON.stringify(expected));

    expect((await backfill({}, workerEnv)).trained).toBe(1);
    await stage("msg_off_backfill_2", "inb_spam", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, "spammy.test", workerEnv);
    const after = await stored("msg_off_backfill_2");
    expect(JSON.stringify({
      score: after.spam_score,
      reasons: JSON.parse(after.spam_reasons_json ?? "[]"),
      verdict: after.spam_verdict,
    })).toBe(JSON.stringify(expected));
    expect(JSON.parse(after.spam_reasons_json ?? "[]").some((reason: string) => String(reason).startsWith("bayes_"))).toBe(false);
    expect(await trainingCount()).toBe(1);
  });

  it("backfills one page lazily the first time an inbox has no training rows", async () => {
    await markOff("msg_lazy", "inb_spam", SPAM_FROM, SPAM_SUBJECT, SPAM_TEXT, true);
    expect(await trainingCount()).toBe(0);
    await stage("msg_lazy_new", "inb_spam", HAM_FROM, HAM_SUBJECT, "A weekly note.", "weekly.test", learnEnv);
    expect(await trainingLabel("msg_lazy")).toBe("spam");
    expect(await classCounts("inb_spam")).toEqual({ spam_messages: 1, ham_messages: 0 });
    const scored = await stored("msg_lazy_new");
    const expected = scoreSpam(rulesInput(HAM_FROM, HAM_SUBJECT, "A weekly note.", passingAuth("weekly.test")));
    expect(JSON.stringify({
      score: scored.spam_score,
      reasons: JSON.parse(scored.spam_reasons_json ?? "[]"),
      verdict: scored.spam_verdict,
    })).toBe(JSON.stringify(expected));
    await stage("msg_lazy_new_2", "inb_spam", HAM_FROM, HAM_SUBJECT, "A weekly note.", "weekly.test", learnEnv);
    expect(await classCounts("inb_spam")).toEqual({ spam_messages: 1, ham_messages: 0 });
    expect(await trainingCount()).toBe(1);
  });
});

async function markOff(id: string, inboxId: string, from: string, subject: string, text: string, spam: boolean): Promise<void> {
  await ready(id, inboxId, from, subject, text);
  const route = spam ? "mark-spam" : "mark-not-spam";
  const response = await api(`/v1/messages/${id}/${route}`, { method: "POST", body: "{}" }, workerEnv);
  expect(response.status, id).toBe(200);
}

async function markLive(id: string, spam: boolean, executionEnv: Env): Promise<void> {
  await ready(id, "inb_spam", spam ? SPAM_FROM : HAM_FROM, spam ? SPAM_SUBJECT : HAM_SUBJECT, SPAM_TEXT);
  const route = spam ? "mark-spam" : "mark-not-spam";
  const response = await api(`/v1/messages/${id}/${route}`, { method: "POST", body: "{}" }, executionEnv);
  expect(response.status, id).toBe(200);
}

async function backfill(
  body: { limit?: number; cursor?: string } = {},
  executionEnv: Env = learnEnv,
): Promise<{
  status: number;
  inbox_id: string;
  trained: number;
  unchanged: number;
  skipped: number;
  done: boolean;
  next_cursor: string | null;
}> {
  const response = await api("/v1/inboxes/inb_spam/spam-training", {
    method: "POST",
    body: JSON.stringify(body),
  }, executionEnv);
  const payload = await response.json() as { data?: {
    inbox_id: string;
    trained: number;
    unchanged: number;
    skipped: number;
    done: boolean;
    next_cursor: string | null;
  } };
  return { status: response.status, ...payload.data! };
}

async function trainingLabel(messageId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT label FROM message_spam_training WHERE message_id = ?",
  ).bind(messageId).first<{ label: string }>();
  return row?.label ?? null;
}

async function trainingCountFor(inboxId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM message_spam_training WHERE inbox_id = ?",
  ).bind(inboxId).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function markClass(label: "spam" | "ham", prefix: string, count: number): Promise<void> {
  const subject = label === "spam" ? SPAM_SUBJECT : HAM_SUBJECT;
  const from = label === "spam" ? SPAM_FROM : HAM_FROM;
  const route = label === "spam" ? "mark-spam" : "mark-not-spam";
  for (let index = 0; index < count; index += 1) {
    const id = `msg_${prefix}_${index}`;
    await ready(id, "inb_spam", from, subject, `${SPAM_TEXT} ${prefix} ${index}`);
    const response = await api(`/v1/messages/${id}/${route}`, { method: "POST", body: "{}" }, learnEnv);
    expect(response.status, id).toBe(200);
  }
}

async function ready(id: string, inboxId: string, from: string, subject: string, text: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages (
      id, inbox_id, direction, envelope_from, envelope_to, subject, text_excerpt, parse_status, agent_state,
      labels_json, headers_json, received_at, created_at, updated_at
    ) VALUES (?, ?, 'inbound', ?, 'spam@mail.example.com', ?, ?, 'ready', 'unprocessed', '[]', '{}', ?, ?, ?)`,
  ).bind(id, inboxId, from, subject, text, now, now, now).run();
}

async function stage(
  id: string,
  inboxId: string,
  from: string,
  subject: string,
  text: string,
  authDomain: string,
  executionEnv: Env,
  auth = "dmarc=pass",
): Promise<void> {
  const raw = [
    `From: ${from}`,
    "To: spam@mail.example.com",
    `Subject: ${subject}`,
    `Authentication-Results: mx.cloudflare.net; dkim=pass; spf=pass; ${auth}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
  ].join("\r\n");
  const key = `messages/${inboxId}/${id}/raw.eml`;
  await env.MAIL_BUCKET.put(key, raw);
  await env.DB.prepare(
    `INSERT INTO messages (
      id, inbox_id, direction, envelope_from, envelope_to, subject, raw_r2_key, parse_status, agent_state,
      labels_json, headers_json, received_at, created_at, updated_at
    ) VALUES (?, ?, 'inbound', ?, 'spam@mail.example.com', ?, ?, 'pending', 'unprocessed', '[]', '{}', ?, ?, ?)`,
  ).bind(id, inboxId, from, subject, key, now, now, now).run();
  await parseMessage({ kind: "parse", messageId: id, rawR2Key: key }, executionEnv);
}

async function seedExtremeModel(inboxId: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO inbox_spam_class_counts (inbox_id, spam_messages, ham_messages, updated_at) VALUES (?, 40, 40, ?)",
  ).bind(inboxId, now).run();
  for (const token of ["prizewinner", "wiretransfer", "limitedoffer", "domain:spammy.test"]) {
    await env.DB.prepare(
      "INSERT INTO inbox_spam_token_counts (inbox_id, token, spam_count, ham_count) VALUES (?, ?, 40, 0)",
    ).bind(inboxId, token).run();
  }
}

function rulesInput(
  from: string,
  subject: string,
  text: string,
  authenticationResults: string | null,
  bayes?: { spamProbability: number | null },
) {
  return {
    from,
    subject,
    text,
    authenticationResults,
    recipientDomain: "mail.example.com",
    lists: EMPTY_LISTS,
    threshold: 60,
    ...(bayes ? { bayes } : {}),
  };
}

function passingAuth(domain: string): string {
  return `mx.cloudflare.net; dkim=pass header.d=${domain}; spf=pass; dmarc=pass header.from=${domain}`;
}

async function stored(id: string): Promise<{
  folder: string;
  labels_json: string;
  spam_score: number | null;
  spam_reasons_json: string | null;
  spam_verdict: string | null;
  parse_status: string;
  tombstoned_at: string | null;
}> {
  const row = await env.DB.prepare(
    `SELECT folder, labels_json, spam_score, spam_reasons_json, spam_verdict, parse_status, tombstoned_at
     FROM messages WHERE id = ?`,
  ).bind(id).first<{
    folder: string;
    labels_json: string;
    spam_score: number | null;
    spam_reasons_json: string | null;
    spam_verdict: string | null;
    parse_status: string;
    tombstoned_at: string | null;
  }>();
  if (!row) throw new Error(`missing message ${id}`);
  return row;
}

async function classCounts(inboxId: string): Promise<{ spam_messages: number; ham_messages: number } | null> {
  return env.DB.prepare(
    "SELECT spam_messages, ham_messages FROM inbox_spam_class_counts WHERE inbox_id = ?",
  ).bind(inboxId).first<{ spam_messages: number; ham_messages: number }>();
}

async function tokenCounts(inboxId: string): Promise<Array<{ token: string; spam_count: number; ham_count: number }>> {
  const rows = await env.DB.prepare(
    "SELECT token, spam_count, ham_count FROM inbox_spam_token_counts WHERE inbox_id = ? ORDER BY token",
  ).bind(inboxId).all<{ token: string; spam_count: number; ham_count: number }>();
  return rows.results;
}

async function trainingCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM message_spam_training").first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function insertKey(keyId: string, token: string, scopes: string[]): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO api_keys (key_id, digest_sha256, label, scopes_json, created_at) VALUES (?, ?, 'learn', ?, ?)",
  ).bind(keyId, await sha256Hex(token), JSON.stringify(scopes), now).run();
}

function api(
  path: string,
  init: { method?: string; body?: string } = {},
  executionEnv: Env = workerEnv,
  token = updateToken,
): Promise<Response> {
  return handleApi(new Request(`https://worker.example${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body,
  }), executionEnv);
}

function rpc(
  token: string,
  name: string,
  args: Record<string, unknown>,
  executionEnv: Env,
): Promise<{ result?: { isError?: boolean; content?: Array<{ text: string }> } }> {
  return handleApi(new Request("https://worker.example/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), executionEnv).then(async (response) => response.json() as Promise<{
    result?: { isError?: boolean; content?: Array<{ text: string }> };
  }>);
}
