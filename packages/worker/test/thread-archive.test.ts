import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleApi } from "../src/api.js";
import type { Env } from "../src/types.js";
import { sha256Hex } from "../src/util.js";

const workerEnv = env as unknown as Env;
const now = "2026-07-11T00:00:00.000Z";
const token = `apo_threadarchive01_${"D".repeat(43)}`;
const readOnlyToken = `apo_threadarchive02_${"E".repeat(43)}`;
const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const thread = "msg_thread_root";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM idempotency_keys"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM inboxes"),
    env.DB.prepare("DELETE FROM api_keys"),
  ]);
  await env.DB.prepare(
    "INSERT INTO inboxes (id, domain, local_part, display_name, active, created_at, updated_at) VALUES ('inb_home', 'mail.example.com', 'home', 'Home', 1, ?, ?)",
  ).bind(now, now).run();
  await env.DB.prepare(
    "INSERT INTO inboxes (id, domain, local_part, display_name, active, created_at, updated_at) VALUES ('inb_other', 'mail.example.com', 'other', 'Other', 1, ?, ?)",
  ).bind(now, now).run();
  await env.DB.prepare(
    "INSERT INTO api_keys (key_id, digest_sha256, label, scopes_json, created_at) VALUES (?, ?, 'test', ?, ?)",
  ).bind(
    "threadarchive01",
    await sha256Hex(token),
    JSON.stringify(["messages:read", "messages:update"]),
    now,
  ).run();
  await env.DB.prepare(
    "INSERT INTO api_keys (key_id, digest_sha256, label, scopes_json, created_at) VALUES (?, ?, 'read-only', ?, ?)",
  ).bind(
    "threadarchive02",
    await sha256Hex(readOnlyToken),
    JSON.stringify(["messages:read"]),
    now,
  ).run();
});

describe("thread filter", () => {
  it("matches thread_id exactly, stays inside the requested inbox, and combines with the other list filters", async () => {
    await seedMessage({
      id: "msg_home_old",
      inboxId: "inb_home",
      threadId: thread,
      receivedAt: "2026-07-01T00:00:00.000Z",
      subject: "home-old",
      direction: "inbound",
      agentState: "unprocessed",
    });
    await seedMessage({
      id: "msg_home_mid",
      inboxId: "inb_home",
      threadId: thread,
      receivedAt: "2026-07-02T00:00:00.000Z",
      subject: "home-mid",
      direction: "inbound",
      agentState: "processed",
      repliedAt: "2026-07-02T03:00:00.000Z",
      lastReplyMessageId: "msg_prior_reply",
      archivedAt: "2026-07-02T04:00:00.000Z",
    });
    await seedMessage({
      id: "msg_home_new",
      inboxId: "inb_home",
      threadId: thread,
      receivedAt: "2026-07-03T00:00:00.000Z",
      subject: "home-new",
      direction: "outbound",
      agentState: "processed",
    });
    await seedMessage({
      id: "msg_home_other_thread",
      inboxId: "inb_home",
      threadId: "msg_other_thread",
      receivedAt: "2026-07-02T00:00:00.000Z",
      subject: "home-other-thread",
    });
    await seedMessage({
      id: "msg_home_tombstone",
      inboxId: "inb_home",
      threadId: thread,
      receivedAt: "2026-07-01T01:00:00.000Z",
      subject: "home-tombstone",
      tombstonedAt: "2026-07-04T00:00:00.000Z",
    });
    await seedMessage({
      id: "msg_other_shared_thread",
      inboxId: "inb_other",
      threadId: thread,
      receivedAt: "2026-07-02T01:00:00.000Z",
      subject: "other-inbox-secret",
      text: "other-inbox-body",
    });
    await seedMessage({
      id: "msg_other_private",
      inboxId: "inb_other",
      threadId: "msg_foreign_thread",
      receivedAt: "2026-07-02T02:00:00.000Z",
      subject: "foreign-thread-secret",
      text: "foreign-thread-body",
    });

    const home = await handleApi(readRequest(
      `/v1/messages?thread_id=${thread}&inbox_id=inb_home&order=asc`,
    ), workerEnv);
    expect(home.status).toBe(200);
    const homeBody = await home.json() as { data: Array<{ id: string; thread_id: string | null; subject: string }>; next_cursor: string | null };
    expect(homeBody.data.map((message) => message.id)).toEqual(["msg_home_old", "msg_home_mid", "msg_home_new"]);
    expect(homeBody.data.every((message) => message.thread_id === thread)).toBe(true);
    expect(JSON.stringify(homeBody)).not.toContain("other-inbox");
    expect(JSON.stringify(homeBody)).not.toContain("foreign-thread");

    const otherInbox = await handleApi(readRequest(
      `/v1/messages?thread_id=${thread}&inbox_id=inb_other&order=asc`,
    ), workerEnv);
    const otherBody = await otherInbox.json() as { data: Array<{ id: string; inbox: { id: string } }> };
    expect(otherBody.data.map((message) => message.id)).toEqual(["msg_other_shared_thread"]);
    expect(otherBody.data.every((message) => message.inbox.id === "inb_other")).toBe(true);

    const foreign = await handleApi(readRequest(
      "/v1/messages?thread_id=msg_foreign_thread&inbox_id=inb_home",
    ), workerEnv);
    expect(foreign.status).toBe(200);
    expect(await foreign.json()).toEqual({ data: [], next_cursor: null });

    const injected = await handleApi(readRequest(
      `/v1/messages?thread_id=${encodeURIComponent(`${thread}' OR '1'='1`)}&inbox_id=inb_home`,
    ), workerEnv);
    expect(injected.status).toBe(200);
    expect(await injected.json()).toEqual({ data: [], next_cursor: null });

    const narrow = await handleApi(readRequest(
      `/v1/messages?thread_id=${thread}&inbox_id=inb_home&state=unprocessed&direction=inbound&replied=false&archived=false&since=2026-07-01T00:00:00.000Z&until=2026-07-01T00:00:00.000Z&order=asc`,
    ), workerEnv);
    expect(narrow.status).toBe(200);
    const narrowBody = await narrow.json() as { data: Array<{ id: string; state: string; replied_at: string | null; archived_at: string | null; direction: string }> };
    expect(narrowBody.data.map((message) => message.id)).toEqual(["msg_home_old"]);
    expect(narrowBody.data[0]).toMatchObject({
      state: "unprocessed",
      direction: "inbound",
      replied_at: null,
      archived_at: null,
    });

    const page = await handleApi(readRequest(
      `/v1/messages?thread_id=${thread}&inbox_id=inb_home&order=asc&limit=2`,
    ), workerEnv);
    const pageBody = await page.json() as { data: Array<{ id: string }>; next_cursor: string };
    expect(pageBody.data.map((message) => message.id)).toEqual(["msg_home_old", "msg_home_mid"]);
    const next = await handleApi(readRequest(
      `/v1/messages?thread_id=${thread}&inbox_id=inb_home&order=asc&limit=2&cursor=${encodeURIComponent(pageBody.next_cursor)}`,
    ), workerEnv);
    const nextBody = await next.json() as { data: Array<{ id: string }>; next_cursor: string | null };
    expect(nextBody.data.map((message) => message.id)).toEqual(["msg_home_new"]);
    expect(nextBody.next_cursor).toBeNull();

    const descending = await handleApi(readRequest(
      `/v1/messages?thread_id=${thread}&inbox_id=inb_home&order=desc`,
    ), workerEnv);
    const descendingBody = await descending.json() as { data: Array<{ id: string }> };
    expect(descendingBody.data.map((message) => message.id)).toEqual(["msg_home_new", "msg_home_mid", "msg_home_old"]);
  });

  it("uses the thread feed index for the existing received_at, id order", async () => {
    await seedMessage({ id: "msg_indexed", inboxId: "inb_home", threadId: thread, receivedAt: now });
    const prepared: Array<{ sql: string; bindings: unknown[] }> = [];
    const response = await handleApi(
      readRequest(`/v1/messages?thread_id=${thread}&order=asc&limit=25`),
      recordingEnv(prepared),
    );
    expect(response.status).toBe(200);
    const list = prepared.find((entry) => entry.sql.includes("FROM messages m"));
    expect(list?.sql).toContain("m.thread_id = ?");
    expect(list?.sql).toContain("m.tombstoned_at IS NULL");
    expect(list?.sql).toContain("ORDER BY m.received_at ASC, m.id ASC");
    expect(list?.sql).not.toMatch(/INDEXED BY/i);
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${list!.sql}`).bind(...(list!.bindings as string[])).all();
    expect(JSON.stringify(plan.results)).toContain("messages_thread_feed_idx");
  });
});

describe("archive marker", () => {
  it("sets and clears archived_at without changing processed state or replied_at", async () => {
    await seedMessage({
      id: "msg_keep",
      inboxId: "inb_home",
      threadId: thread,
      receivedAt: now,
      agentState: "processed",
      repliedAt: "2026-07-11T03:00:00.000Z",
      lastReplyMessageId: "msg_prior_reply",
      labelsJson: JSON.stringify(["keep"]),
    });

    const forbidden = await handleApi(patchRequest("msg_keep", { archived: true }, readOnlyToken), workerEnv);
    expect(forbidden.status).toBe(403);
    expect(await row("msg_keep")).toMatchObject({ archived_at: null, agent_state: "processed" });

    const archived = await handleApi(patchRequest("msg_keep", { archived: true }), workerEnv);
    expect(archived.status).toBe(200);
    const archivedBody = await archived.json() as {
      data: { state: string; labels: string[]; archived_at: string | null; updated_at: string };
    };
    expect(archivedBody.data.state).toBe("processed");
    expect(archivedBody.data.labels).toEqual(["keep"]);
    expect(archivedBody.data.archived_at).toMatch(isoTimestamp);
    const stored = await row("msg_keep");
    expect(stored).toMatchObject({
      agent_state: "processed",
      replied_at: "2026-07-11T03:00:00.000Z",
      last_reply_message_id: "msg_prior_reply",
      labels_json: JSON.stringify(["keep"]),
      archived_at: archivedBody.data.archived_at,
    });
    expect(stored.updated_at).toBe(archivedBody.data.updated_at);

    const repeated = await handleApi(patchRequest("msg_keep", { archived: true }), workerEnv);
    expect(repeated.status).toBe(200);
    expect((await repeated.json() as { data: { archived_at: string | null } }).data.archived_at).toBe(stored.archived_at);
    expect((await row("msg_keep")).replied_at).toBe("2026-07-11T03:00:00.000Z");

    const stateOnly = await handleApi(patchRequest("msg_keep", { state: "unprocessed" }), workerEnv);
    expect(stateOnly.status).toBe(200);
    expect((await stateOnly.json() as { data: { state: string; archived_at: string | null } }).data).toMatchObject({
      state: "unprocessed",
      archived_at: stored.archived_at,
    });
    expect(await row("msg_keep")).toMatchObject({
      agent_state: "unprocessed",
      archived_at: stored.archived_at,
      replied_at: "2026-07-11T03:00:00.000Z",
      last_reply_message_id: "msg_prior_reply",
    });

    const cleared = await handleApi(patchRequest("msg_keep", { archived: false }), workerEnv);
    expect(cleared.status).toBe(200);
    expect((await cleared.json() as { data: { state: string; archived_at: string | null } }).data).toMatchObject({
      state: "unprocessed",
      archived_at: null,
    });
    expect(await row("msg_keep")).toMatchObject({
      agent_state: "unprocessed",
      archived_at: null,
      replied_at: "2026-07-11T03:00:00.000Z",
      last_reply_message_id: "msg_prior_reply",
    });

    const fetched = await handleApi(readRequest("/v1/messages/msg_keep"), workerEnv);
    expect((await fetched.json() as { data: { archived_at: string | null; state: string; replied_at: string | null } }).data).toMatchObject({
      archived_at: null,
      state: "unprocessed",
      replied_at: "2026-07-11T03:00:00.000Z",
    });

    const invalid = await handleApi(patchRequest("msg_keep", { archived: "yes" }), workerEnv);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: { code: "invalid_request", message: "archived must be a boolean" } });
    expect(await row("msg_keep")).toMatchObject({ archived_at: null, agent_state: "unprocessed", replied_at: "2026-07-11T03:00:00.000Z" });
  });

  it("keeps archived messages in the default feed and filters archived=true|false", async () => {
    await seedMessage({ id: "msg_open", inboxId: "inb_home", threadId: thread, receivedAt: "2026-07-01T00:00:00.000Z", subject: "open" });
    await seedMessage({
      id: "msg_filed",
      inboxId: "inb_home",
      threadId: thread,
      receivedAt: "2026-07-02T00:00:00.000Z",
      subject: "filed",
      agentState: "processed",
      archivedAt: "2026-07-02T05:00:00.000Z",
      repliedAt: "2026-07-02T03:00:00.000Z",
    });

    const defaults = await handleApi(readRequest("/v1/messages?order=asc"), workerEnv);
    expect(defaults.status).toBe(200);
    const defaultBody = await defaults.json() as { data: Array<{ id: string; archived_at: string | null; state: string }> };
    expect(defaultBody.data.map((message) => message.id)).toEqual(["msg_open", "msg_filed"]);
    expect(defaultBody.data[1]).toMatchObject({
      archived_at: "2026-07-02T05:00:00.000Z",
      state: "processed",
    });

    const filed = await handleApi(readRequest("/v1/messages?archived=true&order=asc"), workerEnv);
    const filedBody = await filed.json() as { data: Array<{ id: string; replied_at: string | null }> };
    expect(filedBody.data.map((message) => message.id)).toEqual(["msg_filed"]);
    expect(filedBody.data[0]?.replied_at).toBe("2026-07-02T03:00:00.000Z");

    const open = await handleApi(readRequest("/v1/messages?archived=false&state=unprocessed&order=asc"), workerEnv);
    const openBody = await open.json() as { data: Array<{ id: string }> };
    expect(openBody.data.map((message) => message.id)).toEqual(["msg_open"]);
  });

  it("pages an archived feed in descending order without including unarchived rows", async () => {
    await seedMessage({ id: "msg_z", inboxId: "inb_home", threadId: thread, receivedAt: "2026-07-05T00:00:00.000Z", archivedAt: "2026-07-05T01:00:00.000Z" });
    await seedMessage({ id: "msg_y", inboxId: "inb_home", threadId: thread, receivedAt: "2026-07-04T00:00:00.000Z" });
    await seedMessage({ id: "msg_b", inboxId: "inb_home", threadId: thread, receivedAt: "2026-07-03T00:00:00.000Z", archivedAt: "2026-07-03T01:00:00.000Z" });
    await seedMessage({ id: "msg_a", inboxId: "inb_home", threadId: thread, receivedAt: "2026-07-03T00:00:00.000Z", archivedAt: "2026-07-03T01:00:00.000Z" });
    await seedMessage({ id: "msg_w", inboxId: "inb_home", threadId: thread, receivedAt: "2026-07-01T00:00:00.000Z", archivedAt: "2026-07-01T01:00:00.000Z" });

    const page = await handleApi(readRequest("/v1/messages?archived=true&order=desc&limit=2"), workerEnv);
    expect(page.status).toBe(200);
    const pageBody = await page.json() as { data: Array<{ id: string }>; next_cursor: string };
    expect(pageBody.data.map((message) => message.id)).toEqual(["msg_z", "msg_b"]);
    const next = await handleApi(readRequest(
      `/v1/messages?archived=true&order=desc&limit=2&cursor=${encodeURIComponent(pageBody.next_cursor)}`,
    ), workerEnv);
    expect(next.status).toBe(200);
    const nextBody = await next.json() as { data: Array<{ id: string }>; next_cursor: string | null };
    expect(nextBody.data.map((message) => message.id)).toEqual(["msg_a", "msg_w"]);
    expect(nextBody.next_cursor).toBeNull();
    expect([...pageBody.data, ...nextBody.data].map((message) => message.id)).not.toContain("msg_y");
  });

  it("archives outbound mail, rejects a tombstone and a null flag, and can set state in the same write", async () => {
    await seedMessage({
      id: "msg_out",
      inboxId: "inb_home",
      threadId: thread,
      receivedAt: now,
      direction: "outbound",
      agentState: "unprocessed",
    });
    await seedMessage({
      id: "msg_dead",
      inboxId: "inb_home",
      threadId: thread,
      receivedAt: now,
      tombstonedAt: "2026-07-11T01:00:00.000Z",
    });
    await seedMessage({
      id: "msg_both",
      inboxId: "inb_home",
      threadId: thread,
      receivedAt: now,
      agentState: "unprocessed",
      repliedAt: "2026-07-11T03:00:00.000Z",
      lastReplyMessageId: "msg_prior_reply",
      labelsJson: JSON.stringify(["keep"]),
    });

    const outbound = await handleApi(patchRequest("msg_out", { archived: true }), workerEnv);
    expect(outbound.status).toBe(200);
    const outboundBody = await outbound.json() as { data: { state: string; archived_at: string | null } };
    expect(outboundBody.data.state).toBe("unprocessed");
    expect(outboundBody.data.archived_at).toMatch(isoTimestamp);
    expect(await row("msg_out")).toMatchObject({ agent_state: "unprocessed", archived_at: outboundBody.data.archived_at });

    const tombstone = await handleApi(patchRequest("msg_dead", { archived: true }), workerEnv);
    expect(tombstone.status).toBe(404);
    expect(await tombstone.json()).toEqual({ error: { code: "not_found", message: "Message not found" } });
    expect(await row("msg_dead")).toMatchObject({ archived_at: null, agent_state: "unprocessed" });

    const invalid = await handleApi(patchRequest("msg_both", { archived: null }), workerEnv);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: { code: "invalid_request", message: "archived must be a boolean" } });
    expect(await row("msg_both")).toMatchObject({ archived_at: null, agent_state: "unprocessed" });

    const combined = await handleApi(patchRequest("msg_both", { state: "processed", archived: true }), workerEnv);
    expect(combined.status).toBe(200);
    const combinedBody = await combined.json() as {
      data: { state: string; labels: string[]; archived_at: string | null };
    };
    expect(combinedBody.data.state).toBe("processed");
    expect(combinedBody.data.labels).toEqual(["keep"]);
    expect(combinedBody.data.archived_at).toMatch(isoTimestamp);
    expect(await row("msg_both")).toMatchObject({
      agent_state: "processed",
      labels_json: JSON.stringify(["keep"]),
      archived_at: combinedBody.data.archived_at,
      replied_at: "2026-07-11T03:00:00.000Z",
      last_reply_message_id: "msg_prior_reply",
    });
  });

  it("does not revert a state change that lands before an archive-only write", async () => {
    await seedMessage({
      id: "msg_race",
      inboxId: "inb_home",
      threadId: thread,
      receivedAt: now,
      agentState: "unprocessed",
      repliedAt: "2026-07-11T03:00:00.000Z",
      labelsJson: JSON.stringify(["keep"]),
    });
    const archived = await handleApi(patchRequest("msg_race", { archived: true }), racingArchiveEnv("msg_race"));
    expect(archived.status).toBe(200);
    const body = await archived.json() as { data: { state: string; archived_at: string | null } };
    expect(body.data.state).toBe("processed");
    expect(body.data.archived_at).toMatch(isoTimestamp);
    expect(await row("msg_race")).toMatchObject({
      agent_state: "processed",
      archived_at: body.data.archived_at,
      replied_at: "2026-07-11T03:00:00.000Z",
      labels_json: JSON.stringify(["keep"]),
    });
  });
});

describe("list filter validation", () => {
  it("returns 400 invalid_filter for invalid thread, archive, and replied combinations", async () => {
    await seedMessage({ id: "msg_open", inboxId: "inb_home", threadId: thread, receivedAt: now });
    const cases: Array<{ path: string; message: string }> = [
      { path: "/v1/messages?thread_id=", message: "thread_id is invalid" },
      { path: `/v1/messages?thread_id=${"m".repeat(129)}`, message: "thread_id is invalid" },
      { path: "/v1/messages?archived=yes", message: "archived is invalid" },
      { path: "/v1/messages?replied=false&direction=outbound", message: "replied cannot be combined with direction=outbound" },
      {
        path: `/v1/messages?thread_id=${thread}&archived=false&replied=true&direction=outbound`,
        message: "replied cannot be combined with direction=outbound",
      },
      { path: "/v1/messages?thread_id=msg_open&since=yesterday", message: "since must be an ISO timestamp" },
    ];
    for (const entry of cases) {
      const response = await handleApi(readRequest(entry.path), workerEnv);
      expect(response.status, entry.path).toBe(400);
      expect(await response.json(), entry.path).toEqual({ error: { code: "invalid_filter", message: entry.message } });
    }
    expect(await row("msg_open")).toMatchObject({ agent_state: "unprocessed", archived_at: null, replied_at: null });
  });

  it("returns replied messages for one thread", async () => {
    await seedMessage({
      id: "msg_replied",
      inboxId: "inb_home",
      threadId: thread,
      receivedAt: "2026-07-02T00:00:00.000Z",
      repliedAt: "2026-07-02T03:00:00.000Z",
    });
    await seedMessage({
      id: "msg_waiting",
      inboxId: "inb_home",
      threadId: thread,
      receivedAt: "2026-07-03T00:00:00.000Z",
    });
    await seedMessage({
      id: "msg_other_replied",
      inboxId: "inb_home",
      threadId: "msg_other_thread",
      receivedAt: "2026-07-04T00:00:00.000Z",
      repliedAt: "2026-07-04T01:00:00.000Z",
    });
    await seedMessage({
      id: "msg_outbound_reply",
      inboxId: "inb_home",
      threadId: thread,
      receivedAt: "2026-07-01T00:00:00.000Z",
      direction: "outbound",
      repliedAt: "2026-07-01T02:00:00.000Z",
    });

    const response = await handleApi(readRequest(`/v1/messages?replied=true&thread_id=${thread}&order=asc`), workerEnv);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ id: string; replied_at: string | null }> };
    expect(body.data.map((message) => message.id)).toEqual(["msg_replied"]);
    expect(body.data[0]?.replied_at).toBe("2026-07-02T03:00:00.000Z");
  });
});

describe("migration ordering", () => {
  it("serves thread and archive routes after 0005 without a server error", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(messages)").all<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    expect(columns.results.find((column) => column.name === "archived_at")).toMatchObject({
      notnull: 0,
      dflt_value: null,
    });
    const index = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'messages_thread_feed_idx'",
    ).first<{ sql: string }>();
    expect(index?.sql).toContain("thread_id");
    expect(index?.sql).toContain("received_at");
    expect(index?.sql).toContain("id");

    await seedMessage({ id: "msg_schema", inboxId: "inb_home", threadId: thread, receivedAt: now });
    const omitted = await env.DB.prepare(
      "SELECT archived_at FROM messages WHERE id = 'msg_schema'",
    ).first<{ archived_at: string | null }>();
    expect(omitted).toEqual({ archived_at: null });

    const listed = await handleApi(readRequest(`/v1/messages?thread_id=${thread}&archived=false`), workerEnv);
    expect(listed.status).toBe(200);
    expect((await listed.json() as { data: Array<{ id: string; archived_at: string | null }> }).data).toEqual([
      expect.objectContaining({ id: "msg_schema", archived_at: null }),
    ]);
    const archived = await handleApi(patchRequest("msg_schema", { archived: true }), workerEnv);
    expect(archived.status).toBe(200);
    expect((await archived.json() as { data: { archived_at: string | null } }).data.archived_at).toMatch(isoTimestamp);
  });

  it("does not read archived_at for the default feed or processed-state updates", async () => {
    await seedMessage({
      id: "msg_legacy_code",
      inboxId: "inb_home",
      threadId: thread,
      receivedAt: now,
      repliedAt: "2026-07-11T03:00:00.000Z",
    });
    const executionEnv = missingArchivedColumnEnv();

    const listed = await handleApi(readRequest("/v1/messages?order=asc"), executionEnv);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { data: Array<{ id: string; archived_at: string | null }> };
    expect(listedBody.data.map((message) => message.id)).toEqual(["msg_legacy_code"]);
    expect(listedBody.data[0]?.archived_at).toBeNull();

    const threaded = await handleApi(readRequest(`/v1/messages?thread_id=${thread}`), executionEnv);
    expect(threaded.status).toBe(200);
    expect((await threaded.json() as { data: Array<{ id: string }> }).data.map((message) => message.id)).toEqual(["msg_legacy_code"]);

    const processed = await handleApi(patchRequest("msg_legacy_code", { state: "processed" }), executionEnv);
    expect(processed.status).toBe(200);
    expect(await row("msg_legacy_code")).toMatchObject({
      agent_state: "processed",
      replied_at: "2026-07-11T03:00:00.000Z",
      archived_at: null,
    });

    const archivedFilter = await handleApi(readRequest("/v1/messages?archived=false"), executionEnv);
    expect(archivedFilter.status).toBe(503);
    expect(await archivedFilter.json()).toEqual({
      error: { code: "migration_pending", message: "archived_at requires migration 0005" },
    });

    const archivedWrite = await handleApi(patchRequest("msg_legacy_code", { archived: true }), executionEnv);
    expect(archivedWrite.status).toBe(503);
    expect(await archivedWrite.json()).toEqual({
      error: { code: "migration_pending", message: "archived_at requires migration 0005" },
    });
    expect(await row("msg_legacy_code")).toMatchObject({
      agent_state: "processed",
      replied_at: "2026-07-11T03:00:00.000Z",
      archived_at: null,
    });
  });
});

function readRequest(path: string, bearer = token): Request {
  return new Request(`https://worker.example${path}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
}

function patchRequest(messageId: string, body: unknown, bearer = token): Request {
  return new Request(`https://worker.example/v1/messages/${messageId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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

function missingColumnError(): Error {
  return new Error("D1_ERROR: no such column: archived_at: SQLITE_ERROR");
}

function racingArchiveEnv(messageId: string): Env {
  const database = env.DB;
  return {
    ...workerEnv,
    DB: {
      prepare(sql: string) {
        const statement = database.prepare(sql);
        const races = /\bUPDATE\b/i.test(sql) && /\barchived_at\b/i.test(sql);
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            if (!races) return bound;
            const interfere = async () => {
              await database.prepare(
                "UPDATE messages SET agent_state = 'processed' WHERE id = ?",
              ).bind(messageId).run();
            };
            return {
              async all() {
                await interfere();
                return bound.all();
              },
              async run() {
                await interfere();
                return bound.run();
              },
              async first() {
                await interfere();
                return bound.first();
              },
            };
          },
        };
      },
      batch: (statements: D1PreparedStatement[]) => database.batch(statements),
      exec: database.exec.bind(database),
    },
  } as Env;
}

function missingArchivedColumnEnv(): Env {
  const database = env.DB;
  return {
    ...workerEnv,
    DB: {
      prepare(sql: string) {
        if (/\barchived_at\b/i.test(sql)) {
          const rejected = {
            bind(..._values: unknown[]) {
              return rejected;
            },
            async all(): Promise<never> {
              throw missingColumnError();
            },
            async first(): Promise<never> {
              throw missingColumnError();
            },
            async run(): Promise<never> {
              throw missingColumnError();
            },
          };
          return rejected;
        }
        return database.prepare(sql);
      },
      batch: (statements: D1PreparedStatement[]) => database.batch(statements),
      exec: database.exec.bind(database),
    },
  } as Env;
}

async function row(id: string): Promise<{
  agent_state: string;
  replied_at: string | null;
  last_reply_message_id: string | null;
  archived_at: string | null;
  labels_json: string;
  updated_at: string;
}> {
  const stored = await env.DB.prepare(
    "SELECT agent_state, replied_at, last_reply_message_id, archived_at, labels_json, updated_at FROM messages WHERE id = ?",
  ).bind(id).first<{
    agent_state: string;
    replied_at: string | null;
    last_reply_message_id: string | null;
    archived_at: string | null;
    labels_json: string;
    updated_at: string;
  }>();
  if (!stored) throw new Error(`missing message ${id}`);
  return stored;
}

async function seedMessage(input: {
  id: string;
  inboxId: string;
  threadId: string | null;
  receivedAt: string;
  subject?: string;
  text?: string;
  direction?: "inbound" | "outbound";
  agentState?: "processed" | "unprocessed";
  repliedAt?: string | null;
  lastReplyMessageId?: string | null;
  archivedAt?: string | null;
  tombstonedAt?: string | null;
  labelsJson?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages (
      id, inbox_id, direction, envelope_from, envelope_to, subject, text_excerpt,
      parse_status, agent_state, labels_json, headers_json, thread_id,
      replied_at, last_reply_message_id, tombstoned_at, received_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'person@example.net', 'home@mail.example.com', ?, ?,
      'ready', ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.id,
    input.inboxId,
    input.direction ?? "inbound",
    input.subject ?? "Subject",
    input.text ?? "Body",
    input.agentState ?? "unprocessed",
    input.labelsJson ?? "[]",
    input.threadId,
    input.repliedAt ?? null,
    input.lastReplyMessageId ?? null,
    input.tombstonedAt ?? null,
    input.receivedAt,
    input.receivedAt,
    input.receivedAt,
  ).run();
  if (input.archivedAt) {
    await env.DB.prepare("UPDATE messages SET archived_at = ? WHERE id = ?").bind(input.archivedAt, input.id).run();
  }
}
