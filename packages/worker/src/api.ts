import { authenticate, requireScope } from "./auth.js";
import { errorResponse, HttpError, json, readJson, requireString } from "./http.js";
import { replyToMessage, sendNew } from "./outbound.js";
import type { AttachmentRow, AuthContext, Env, InboxRow, MessageRow, QueueTask } from "./types.js";
import {
  decodeCursor,
  encodeCursor,
  newId,
  normalizeDomain,
  normalizeLocalPart,
  nowIso,
  parseJsonArray,
} from "./util.js";

interface ParsedMessageDocument {
  text?: string;
  html?: string | null;
  from?: unknown;
  to?: unknown;
  cc?: unknown;
  replyTo?: unknown;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: unknown;
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "agentpostoffice" });
    }
    if (!url.pathname.startsWith("/v1/")) throw new HttpError(404, "not_found", "Route not found");
    const auth = await authenticate(request, env);
    return await route(request, url, auth, env);
  } catch (error) {
    return errorResponse(error);
  }
}

async function route(request: Request, url: URL, auth: AuthContext, env: Env): Promise<Response> {
  const segments = url.pathname.split("/").filter(Boolean).slice(1);
  if (segments[0] === "inboxes") return routeInboxes(request, segments.slice(1), auth, env);
  if (segments[0] === "messages") return routeMessages(request, url, segments.slice(1), auth, env);
  throw new HttpError(404, "not_found", "Route not found");
}

async function routeInboxes(
  request: Request,
  segments: string[],
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  if (segments.length === 0 && request.method === "GET") {
    requireScope(auth, "messages:read");
    const result = await env.DB.prepare(
      "SELECT * FROM inboxes WHERE domain = ? ORDER BY local_part ASC",
    ).bind(normalizeDomain(env.MAIL_DOMAIN)).all<InboxRow>();
    return json({ data: result.results.map(serializeInbox) });
  }
  if (segments.length === 0 && request.method === "POST") {
    requireScope(auth, "inboxes:manage");
    const input = await readJson<Record<string, unknown>>(request);
    let localPart: string;
    try {
      localPart = normalizeLocalPart(requireString(input.local_part, "local_part", 64));
    } catch {
      throw new HttpError(400, "invalid_request", "local_part is invalid");
    }
    const displayName = optionalDisplayName(input.display_name);
    const now = nowIso();
    const inbox: InboxRow = {
      id: newId("inb"),
      domain: normalizeDomain(env.MAIL_DOMAIN),
      local_part: localPart,
      display_name: displayName,
      active: 1,
      created_at: now,
      updated_at: now,
    };
    try {
      await env.DB.prepare(
        "INSERT INTO inboxes (id, domain, local_part, display_name, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
      ).bind(inbox.id, inbox.domain, inbox.local_part, inbox.display_name, now, now).run();
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new HttpError(409, "inbox_exists", "Mailbox already exists");
      throw error;
    }
    return json({ data: serializeInbox(inbox) }, 201);
  }

  const inboxId = segments[0];
  if (!inboxId || segments.length !== 1) throw new HttpError(404, "not_found", "Route not found");
  if (request.method === "GET") {
    requireScope(auth, "messages:read");
    return json({ data: serializeInbox(await getInbox(inboxId, env)) });
  }
  if (request.method === "PATCH") {
    requireScope(auth, "inboxes:manage");
    const current = await getInbox(inboxId, env);
    const input = await readJson<Record<string, unknown>>(request);
    const displayName = input.display_name === undefined ? current.display_name : optionalDisplayName(input.display_name);
    const active = input.active === undefined ? current.active : input.active === true ? 1 : input.active === false ? 0 : invalidActive();
    const updatedAt = nowIso();
    await env.DB.prepare(
      "UPDATE inboxes SET display_name = ?, active = ?, updated_at = ? WHERE id = ?",
    ).bind(displayName, active, updatedAt, inboxId).run();
    return json({ data: serializeInbox({ ...current, display_name: displayName, active, updated_at: updatedAt }) });
  }
  throw new HttpError(405, "method_not_allowed", "Method not allowed", { Allow: "GET, PATCH" });
}

async function routeMessages(
  request: Request,
  url: URL,
  segments: string[],
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  if (segments.length === 0 && request.method === "GET") {
    requireScope(auth, "messages:read");
    return listMessages(url, env);
  }
  if (segments.length === 0 && request.method === "POST") {
    requireScope(auth, "messages:send");
    const input = await readJson<Record<string, unknown>>(request, 1_100_000);
    const result = await sendNew(input, requireIdempotencyKey(request), auth, env);
    return json({ data: result.body }, result.status);
  }
  if (segments[0] === "bulk-delete" && segments.length === 1 && request.method === "POST") {
    requireScope(auth, "messages:delete");
    return bulkDelete(request, env);
  }

  const messageId = segments[0];
  if (!messageId) throw new HttpError(404, "not_found", "Route not found");
  if (segments.length === 1 && request.method === "GET") {
    requireScope(auth, "messages:read");
    return getMessageResponse(messageId, url, env);
  }
  if (segments.length === 1 && request.method === "PATCH") {
    requireScope(auth, "messages:update");
    return updateMessage(request, messageId, env);
  }
  if (segments.length === 1 && request.method === "DELETE") {
    requireScope(auth, "messages:delete");
    return deleteMessage(messageId, env);
  }
  if (segments[1] === "reply" && segments.length === 2 && request.method === "POST") {
    requireScope(auth, "messages:reply");
    const input = await readJson<Record<string, unknown>>(request, 1_100_000);
    const result = await replyToMessage(messageId, input, requireIdempotencyKey(request), auth, env);
    return json({ data: result.body }, result.status);
  }
  if (segments[1] === "raw" && segments.length === 2 && request.method === "GET") {
    requireScope(auth, "messages:read");
    return streamRaw(messageId, env);
  }
  if (segments[1] === "attachments" && segments[2] && segments.length === 3 && request.method === "GET") {
    requireScope(auth, "messages:read");
    return streamAttachment(messageId, segments[2], env);
  }
  throw new HttpError(404, "not_found", "Route not found");
}

async function listMessages(url: URL, env: Env): Promise<Response> {
  const limit = boundedInteger(url.searchParams.get("limit"), 25, 1, 100);
  const order = url.searchParams.get("order") || "asc";
  if (order !== "asc" && order !== "desc") throw new HttpError(400, "invalid_filter", "order must be asc or desc");
  const state = url.searchParams.get("state");
  if (state && state !== "processed" && state !== "unprocessed") throw new HttpError(400, "invalid_filter", "state is invalid");
  const direction = url.searchParams.get("direction");
  if (direction && direction !== "inbound" && direction !== "outbound") throw new HttpError(400, "invalid_filter", "direction is invalid");
  const inboxId = url.searchParams.get("inbox_id");
  const since = validTimestamp(url.searchParams.get("since"), "since");
  const until = validTimestamp(url.searchParams.get("until"), "until");
  const cursorValue = url.searchParams.get("cursor");
  const cursor = cursorValue ? decodeCursor(cursorValue) : null;

  const clauses = ["m.tombstoned_at IS NULL"];
  const bindings: unknown[] = [];
  if (state) { clauses.push("m.agent_state = ?"); bindings.push(state); }
  if (direction) { clauses.push("m.direction = ?"); bindings.push(direction); }
  if (inboxId) { clauses.push("m.inbox_id = ?"); bindings.push(inboxId); }
  if (since) { clauses.push("m.received_at >= ?"); bindings.push(since); }
  if (until) { clauses.push("m.received_at <= ?"); bindings.push(until); }
  if (cursor) {
    const comparator = order === "asc" ? ">" : "<";
    clauses.push(`(m.received_at ${comparator} ? OR (m.received_at = ? AND m.id ${comparator} ?))`);
    bindings.push(cursor.receivedAt, cursor.receivedAt, cursor.messageId);
  }

  const query = `SELECT m.*, i.domain, i.local_part, i.display_name
    FROM messages m JOIN inboxes i ON i.id = m.inbox_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY m.received_at ${order.toUpperCase()}, m.id ${order.toUpperCase()} LIMIT ?`;
  bindings.push(limit + 1);
  const result = await env.DB.prepare(query).bind(...bindings).all<MessageRow & Pick<InboxRow, "domain" | "local_part" | "display_name">>();
  const hasMore = result.results.length > limit;
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  const attachments = await attachmentMap(rows.map((row) => row.id), env);
  return json({
    data: rows.map((row) => serializeMessage(row, attachments.get(row.id) || [])),
    next_cursor: hasMore && last ? encodeCursor(last.received_at, last.id) : null,
  });
}

async function getMessageResponse(messageId: string, url: URL, env: Env): Promise<Response> {
  const row = await getMessage(messageId, env);
  const inbox = await getInbox(row.inbox_id, env);
  const attachments = await attachmentMap([row.id], env);
  let parsed: ParsedMessageDocument | null = null;
  if (row.parsed_r2_key) {
    const object = await env.MAIL_BUCKET.get(row.parsed_r2_key);
    if (object) parsed = await object.json<ParsedMessageDocument>();
  }
  return json({
    data: {
      ...serializeMessage({
        ...row,
        domain: inbox.domain,
        local_part: inbox.local_part,
        display_name: inbox.display_name,
      }, attachments.get(row.id) || []),
      text: parsed?.text ?? row.text_excerpt ?? "",
      ...(url.searchParams.get("include_html") === "true" ? { html: parsed?.html ?? null } : {}),
    },
  });
}

async function updateMessage(request: Request, messageId: string, env: Env): Promise<Response> {
  const row = await getMessage(messageId, env);
  const input = await readJson<Record<string, unknown>>(request);
  const state = input.state === undefined ? row.agent_state : input.state;
  if (state !== "processed" && state !== "unprocessed") throw new HttpError(400, "invalid_request", "state is invalid");
  const labels = input.labels === undefined ? parseJsonArray(row.labels_json) : validateLabels(input.labels);
  const updatedAt = nowIso();
  await env.DB.prepare(
    "UPDATE messages SET agent_state = ?, labels_json = ?, updated_at = ? WHERE id = ?",
  ).bind(state, JSON.stringify(labels), updatedAt, messageId).run();
  return json({ data: { id: messageId, state, labels, updated_at: updatedAt } });
}

async function deleteMessage(messageId: string, env: Env): Promise<Response> {
  const existing = await env.DB.prepare(
    "SELECT id, tombstoned_at FROM messages WHERE id = ?",
  ).bind(messageId).first<Pick<MessageRow, "id" | "tombstoned_at">>();
  if (!existing) throw new HttpError(404, "not_found", "Message not found");
  const now = nowIso();
  if (!existing.tombstoned_at) {
    await env.DB.prepare("UPDATE messages SET tombstoned_at = ?, updated_at = ? WHERE id = ?").bind(now, now, messageId).run();
  }
  // A prior Queue admission failure must remain recoverable even though the
  // tombstone already hides the content from normal reads.
  const task: QueueTask = { kind: "delete", messageId };
  await env.MAIL_QUEUE.send(task, { contentType: "json" });
  return json({ data: { id: messageId, status: "deletion_queued" } }, 202);
}

async function bulkDelete(request: Request, env: Env): Promise<Response> {
  const input = await readJson<Record<string, unknown>>(request);
  if (!Array.isArray(input.message_ids) || input.message_ids.length === 0 || input.message_ids.length > 100) {
    throw new HttpError(400, "invalid_request", "message_ids must contain 1-100 explicit IDs");
  }
  const ids = [...new Set(input.message_ids)];
  if (!ids.every((id) => typeof id === "string" && /^msg_[a-z0-9]+$/i.test(id))) {
    throw new HttpError(400, "invalid_request", "message_ids contains an invalid ID");
  }
  const placeholders = ids.map(() => "?").join(", ");
  const existing = await env.DB.prepare(
    `SELECT id FROM messages WHERE id IN (${placeholders})`,
  ).bind(...ids).all<Pick<MessageRow, "id">>();
  const existingSet = new Set(existing.results.map((row) => row.id));
  const queuedIds = ids.filter((id): id is string => existingSet.has(id));
  const now = nowIso();
  const statements = queuedIds.map((id) => env.DB.prepare(
    "UPDATE messages SET tombstoned_at = ?, updated_at = ? WHERE id = ? AND tombstoned_at IS NULL",
  ).bind(now, now, id));
  if (statements.length) await env.DB.batch(statements);
  if (queuedIds.length) {
    // Re-enqueue existing tombstones so a partial prior failure cannot make
    // retained message data unreachable from the deletion API.
    await env.MAIL_QUEUE.sendBatch(queuedIds.map((messageId) => ({
      body: { kind: "delete", messageId } satisfies QueueTask,
      contentType: "json" as const,
    })));
  }
  return json({ data: { status: "deletion_queued", message_ids: queuedIds } }, 202);
}

async function streamRaw(messageId: string, env: Env): Promise<Response> {
  const row = await getMessage(messageId, env);
  if (!row.raw_r2_key) throw new HttpError(404, "not_found", "Raw message is not available");
  const object = await env.MAIL_BUCKET.get(row.raw_r2_key);
  if (!object) throw new HttpError(404, "not_found", "Raw message is not available");
  return new Response(object.body, {
    headers: secureDownloadHeaders("message/rfc822", `${messageId}.eml`, object.size),
  });
}

async function streamAttachment(messageId: string, attachmentId: string, env: Env): Promise<Response> {
  await getMessage(messageId, env);
  const row = await env.DB.prepare(
    "SELECT * FROM attachments WHERE id = ? AND message_id = ?",
  ).bind(attachmentId, messageId).first<AttachmentRow>();
  if (!row) throw new HttpError(404, "not_found", "Attachment not found");
  const object = await env.MAIL_BUCKET.get(row.r2_key);
  if (!object) throw new HttpError(404, "not_found", "Attachment object not found");
  return new Response(object.body, {
    headers: secureDownloadHeaders(row.media_type || "application/octet-stream", safeFilename(row.filename || row.id), row.size),
  });
}

async function getInbox(id: string, env: Env): Promise<InboxRow> {
  const row = await env.DB.prepare("SELECT * FROM inboxes WHERE id = ?").bind(id).first<InboxRow>();
  if (!row) throw new HttpError(404, "not_found", "Inbox not found");
  return row;
}

async function getMessage(id: string, env: Env): Promise<MessageRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM messages WHERE id = ? AND tombstoned_at IS NULL",
  ).bind(id).first<MessageRow>();
  if (!row) throw new HttpError(404, "not_found", "Message not found");
  return row;
}

async function attachmentMap(messageIds: string[], env: Env): Promise<Map<string, AttachmentRow[]>> {
  const map = new Map<string, AttachmentRow[]>();
  if (messageIds.length === 0) return map;
  const placeholders = messageIds.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT * FROM attachments WHERE message_id IN (${placeholders}) ORDER BY id ASC`,
  ).bind(...messageIds).all<AttachmentRow>();
  for (const row of result.results) map.set(row.message_id, [...(map.get(row.message_id) || []), row]);
  return map;
}

function serializeInbox(row: InboxRow): Record<string, unknown> {
  return {
    id: row.id,
    address: `${row.local_part}@${row.domain}`,
    local_part: row.local_part,
    domain: row.domain,
    display_name: row.display_name,
    active: Boolean(row.active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function serializeMessage(
  row: MessageRow & Partial<Pick<InboxRow, "domain" | "local_part" | "display_name">>,
  attachments: AttachmentRow[],
): Record<string, unknown> {
  return {
    id: row.id,
    inbox: {
      id: row.inbox_id,
      address: row.local_part && row.domain ? `${row.local_part}@${row.domain}` : undefined,
      display_name: row.display_name,
    },
    direction: row.direction,
    received_at: row.received_at,
    sent_at: row.sent_at,
    from: { address: row.envelope_from },
    to: { address: row.envelope_to },
    subject: row.subject,
    text: row.text_excerpt || "",
    body_truncated: Boolean(row.body_truncated),
    attachments: attachments.map(serializeAttachment),
    state: row.agent_state,
    labels: parseJsonArray(row.labels_json),
    parse_status: row.parse_status,
    outbound_status: row.outbound_status,
    cloudflare_message_id: row.cloudflare_message_id,
    untrusted_content: true,
  };
}

function serializeAttachment(row: AttachmentRow): Record<string, unknown> {
  return {
    id: row.id,
    filename: row.filename,
    media_type: row.media_type,
    disposition: row.disposition,
    size: row.size,
    checksum_sha256: row.checksum_sha256,
  };
}

function secureDownloadHeaders(mediaType: string, filename: string, size: number): Headers {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": mediaType,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": String(size),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
}

function optionalDisplayName(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 200 || /[\r\n]/.test(value)) {
    throw new HttpError(400, "invalid_request", "display_name is invalid");
  }
  return value;
}

function invalidActive(): never {
  throw new HttpError(400, "invalid_request", "active must be a boolean");
}

function validTimestamp(value: string | null, name: string): string | null {
  if (!value) return null;
  if (!Number.isFinite(Date.parse(value))) throw new HttpError(400, "invalid_filter", `${name} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, "invalid_filter", `limit must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function validateLabels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20 || !value.every((label) => typeof label === "string" && label.length >= 1 && label.length <= 64)) {
    throw new HttpError(400, "invalid_request", "labels must contain at most 20 strings of 1-64 characters");
  }
  return [...new Set(value)] as string[];
}

function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key");
  if (!value) throw new HttpError(400, "idempotency_key_required", "Idempotency-Key header is required");
  return value;
}

function safeFilename(value: string): string {
  return value.replace(/[\r\n"\\/]/g, "_").slice(0, 180) || "attachment";
}
