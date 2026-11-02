import { HttpError, requireString } from "./http.js";
import {
  appendReference,
  headerValueWithinLimit,
  providerMessageId,
  threadingMessageId,
} from "./threading.js";
import type { AuthContext, Env, InboxRow, MessageRow } from "./types.js";
import { excerptUtf8, newId, normalizeAddress, normalizeDomain, nowIso, sha256Hex } from "./util.js";

interface SendInput {
  inbox_id?: unknown;
  to?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  reply_to?: unknown;
}

interface IdempotencyRow {
  request_digest: string;
  outbound_message_id: string;
  state: "started" | "accepted" | "failed" | "unknown";
  response_json: string | null;
}

export async function sendNew(
  input: SendInput,
  idempotencyKey: string,
  auth: AuthContext,
  env: Env,
): Promise<{ status: number; body: unknown }> {
  const inboxId = requireString(input.inbox_id, "inbox_id", 128);
  const recipient = validAddress(requireString(input.to, "to", 254), "to");
  const subject = requireString(input.subject, "subject", 998).replace(/[\r\n]+/g, " ");
  const text = optionalBody(input.text, "text");
  const html = optionalBody(input.html, "html");
  if (!text && !html) throw new HttpError(400, "invalid_request", "text or html is required");
  const replyTo = input.reply_to === undefined ? undefined : validAddress(requireString(input.reply_to, "reply_to", 254), "reply_to");
  const inbox = await activeInbox(inboxId, env);
  return deliver({ inbox, recipient, subject, text, html, replyTo }, "POST:/v1/messages", idempotencyKey, auth, env);
}

export async function replyToMessage(
  originalId: string,
  input: Pick<SendInput, "text" | "html">,
  idempotencyKey: string,
  auth: AuthContext,
  env: Env,
): Promise<{ status: number; body: unknown }> {
  const original = await env.DB.prepare(
    "SELECT * FROM messages WHERE id = ? AND tombstoned_at IS NULL",
  ).bind(originalId).first<MessageRow>();
  if (!original || original.direction !== "inbound") throw new HttpError(404, "not_found", "Inbound message not found");
  if (original.parse_status !== "ready") throw new HttpError(409, "message_not_ready", "Message is not ready to reply");
  const inbox = await activeInbox(original.inbox_id, env);
  const recipient = validAddress(original.reply_to || original.envelope_from, "reply recipient");
  const text = optionalBody(input.text, "text");
  const html = optionalBody(input.html, "html");
  if (!text && !html) throw new HttpError(400, "invalid_request", "text or html is required");

  const headers = safeHeaders(original.headers_json);
  const originalMessageId = threadingMessageId(headers, original.cloudflare_message_id);
  const references = headerValueWithinLimit(appendReference(headers.references, originalMessageId));
  const inReplyTo = headerValueWithinLimit(originalMessageId);
  const subject = /^re:/i.test(original.subject || "") ? original.subject || "Re:" : `Re: ${original.subject || ""}`;
  return deliver(
    {
      inbox,
      recipient,
      subject,
      text,
      html,
      headers: {
        ...(inReplyTo ? { "In-Reply-To": inReplyTo } : {}),
        ...(references ? { References: references } : {}),
      },
      parentMessageId: original.id,
      threadId: original.thread_id || original.id,
    },
    `POST:/v1/messages/${originalId}/reply`,
    idempotencyKey,
    auth,
    env,
  );
}

async function deliver(
  mail: {
    inbox: InboxRow;
    recipient: string;
    subject: string;
    text?: string;
    html?: string;
    replyTo?: string;
    headers?: Record<string, string>;
    parentMessageId?: string | null;
    threadId?: string | null;
  },
  endpoint: string,
  idempotencyKey: string,
  auth: AuthContext,
  env: Env,
): Promise<{ status: number; body: unknown }> {
  if (!/^[\x21-\x7E]{8,200}$/.test(idempotencyKey)) {
    throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be 8-200 visible ASCII characters");
  }
  const messageId = newId("msg");
  const parentMessageId = mail.parentMessageId ?? null;
  const threadId = mail.threadId || messageId;
  const requestDocument = {
    inboxId: mail.inbox.id,
    to: mail.recipient,
    subject: mail.subject,
    text: mail.text || null,
    html: mail.html || null,
    replyTo: mail.replyTo || null,
    headers: mail.headers || {},
  };
  const requestDigest = await sha256Hex(JSON.stringify(requestDocument));
  const now = nowIso();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO idempotency_keys
      (api_key_id, endpoint, idempotency_key, request_digest, outbound_message_id, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'started', ?, ?)`,
  ).bind(auth.keyId, endpoint, idempotencyKey, requestDigest, messageId, now, now).run();

  if ((inserted.meta.changes ?? 0) === 0) {
    const existing = await env.DB.prepare(
      "SELECT request_digest, outbound_message_id, state, response_json FROM idempotency_keys WHERE api_key_id = ? AND endpoint = ? AND idempotency_key = ?",
    ).bind(auth.keyId, endpoint, idempotencyKey).first<IdempotencyRow>();
    if (!existing || !constantDigest(existing.request_digest, requestDigest)) {
      throw new HttpError(409, "idempotency_conflict", "Idempotency-Key was already used for another request");
    }
    return existingResponse(existing);
  }

  const fromAddress = `${mail.inbox.local_part}@${mail.inbox.domain}`;
  const parsedR2Key = `messages/${mail.inbox.id}/${messageId}/parsed.json`;
  const excerpt = excerptUtf8(mail.text || "", positiveInteger(env.BODY_EXCERPT_BYTES, 8_192));
  await env.MAIL_BUCKET.put(parsedR2Key, JSON.stringify({
    text: mail.text || "",
    html: mail.html || null,
    from: { address: fromAddress, name: mail.inbox.display_name },
    to: [{ address: mail.recipient }],
    replyTo: mail.replyTo ? [{ address: mail.replyTo }] : [],
    subject: mail.subject,
    messageId: null,
    inReplyTo: mail.headers?.["In-Reply-To"] || null,
    references: mail.headers?.References || null,
  }), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  await env.DB.prepare(
    `INSERT INTO messages (
      id, inbox_id, direction, envelope_from, envelope_to, subject, text_excerpt, parsed_r2_key,
      body_truncated, parse_status, agent_state, labels_json, headers_json,
      outbound_status, parent_message_id, thread_id, received_at, created_at, updated_at
    ) VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, 'not_applicable', 'processed', '[]', ?, 'pending', ?, ?, ?, ?, ?)`,
  ).bind(
    messageId,
    mail.inbox.id,
    fromAddress,
    mail.recipient,
    mail.subject,
    excerpt.text,
    parsedR2Key,
    excerpt.truncated ? 1 : 0,
    JSON.stringify({ ...(mail.headers || {}) }),
    parentMessageId,
    threadId,
    now,
    now,
    now,
  ).run();

  try {
    const result = await sendEmail({
      to: mail.recipient,
      from: mail.inbox.display_name ? { email: fromAddress, name: mail.inbox.display_name } : fromAddress,
      subject: mail.subject,
      ...(mail.text ? { text: mail.text } : {}),
      ...(mail.html ? { html: mail.html } : {}),
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      headers: mail.headers || {},
    }, env);
    const providerId = providerMessageId(result);
    const response = { id: messageId, status: "accepted", cloudflare_message_id: providerId };
    try {
      await persistOutboundState(
        messageId,
        auth.keyId,
        endpoint,
        idempotencyKey,
        "accepted",
        response,
        providerId,
        parsedR2Key,
        env,
        parentMessageId ? { originalMessageId: parentMessageId, inboxId: mail.inbox.id } : null,
      );
      return { status: 202, body: response };
    } catch {
      const unknown = { id: messageId, status: "unknown" };
      try {
        await persistOutboundState(messageId, auth.keyId, endpoint, idempotencyKey, "unknown", unknown, null, parsedR2Key, env);
      } catch {
        // The client still receives unknown and must not retry with a new key.
      }
      return { status: 202, body: unknown };
    }
  } catch (error) {
    const response = { id: messageId, status: "failed", error: safeEmailError(error) };
    await persistOutboundState(messageId, auth.keyId, endpoint, idempotencyKey, "failed", response, null, parsedR2Key, env);
    return { status: 502, body: response };
  }
}

export function sendEmail(
  message: Parameters<Env["EMAIL"]["send"]>[0],
  env: Env,
): ReturnType<Env["EMAIL"]["send"]> {
  return env.EMAIL.send(message);
}

export async function sendAutomationReply(
  mail: {
    inbox: InboxRow;
    recipient: string;
    subject: string;
    text: string;
    headers: Record<string, string>;
    parentMessageId?: string | null;
    threadId?: string | null;
  },
  env: Env,
): Promise<{ messageId: string; providerMessageId: string | null }> {
  const messageId = newId("msg");
  const parentMessageId = mail.parentMessageId ?? null;
  const threadId = mail.threadId || messageId;
  const now = nowIso();
  const fromAddress = `${mail.inbox.local_part}@${mail.inbox.domain}`;
  const parsedR2Key = `messages/${mail.inbox.id}/${messageId}/parsed.json`;
  const excerpt = excerptUtf8(mail.text, positiveInteger(env.BODY_EXCERPT_BYTES, 8_192));
  await env.MAIL_BUCKET.put(parsedR2Key, JSON.stringify({
    text: mail.text,
    html: null,
    from: { address: fromAddress, name: mail.inbox.display_name },
    to: [{ address: mail.recipient }],
    replyTo: [],
    subject: mail.subject,
    messageId: null,
    inReplyTo: mail.headers["In-Reply-To"] || null,
    references: mail.headers.References || null,
  }), { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  await env.DB.prepare(
    `INSERT INTO messages (
      id, inbox_id, direction, envelope_from, envelope_to, subject, text_excerpt, parsed_r2_key,
      body_truncated, parse_status, agent_state, labels_json, headers_json,
      outbound_status, parent_message_id, thread_id, received_at, created_at, updated_at
    ) VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, 'not_applicable', 'processed', '[]', ?, 'pending', ?, ?, ?, ?, ?)`,
  ).bind(
    messageId, mail.inbox.id, fromAddress, mail.recipient, mail.subject, excerpt.text, parsedR2Key,
    excerpt.truncated ? 1 : 0, JSON.stringify(mail.headers), parentMessageId, threadId, now, now, now,
  ).run();
  try {
    const result = await sendEmail({
      to: mail.recipient,
      from: mail.inbox.display_name ? { email: fromAddress, name: mail.inbox.display_name } : fromAddress,
      subject: mail.subject,
      text: mail.text,
      headers: mail.headers,
    }, env);
    const providerId = providerMessageId(result);
    const headers = { ...mail.headers };
    if (providerId) headers["message-id"] = providerId;
    await env.DB.prepare(
      "UPDATE messages SET outbound_status = 'accepted', cloudflare_message_id = ?, headers_json = ?, sent_at = ?, updated_at = ? WHERE id = ?",
    ).bind(providerId, JSON.stringify(headers), nowIso(), nowIso(), messageId).run();
    await writeParsedMessageId(env, parsedR2Key, providerId);
    return { messageId, providerMessageId: providerId };
  } catch (error) {
    await env.DB.prepare(
      "UPDATE messages SET outbound_status = 'failed', updated_at = ? WHERE id = ?",
    ).bind(nowIso(), messageId).run();
    throw error;
  }
}

export function acceptedReplyMark(
  env: Env,
  input: { originalMessageId: string; inboxId: string; replyMessageId: string; repliedAt: string },
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE messages
     SET replied_at = ?, last_reply_message_id = ?, updated_at = ?
     WHERE id = ? AND inbox_id = ? AND direction = 'inbound' AND tombstoned_at IS NULL
       AND (replied_at IS NULL OR replied_at < ?)`,
  ).bind(
    input.repliedAt,
    input.replyMessageId,
    input.repliedAt,
    input.originalMessageId,
    input.inboxId,
    input.repliedAt,
  );
}

async function persistOutboundState(
  messageId: string,
  keyId: string,
  endpoint: string,
  idempotencyKey: string,
  state: "accepted" | "failed" | "unknown",
  response: unknown,
  cloudflareMessageId: string | null,
  parsedR2Key: string,
  env: Env,
  reply: { originalMessageId: string; inboxId: string } | null = null,
): Promise<void> {
  const now = nowIso();
  const headersJson = state === "accepted"
    ? await headersWithProviderMessageId(messageId, cloudflareMessageId, env)
    : null;
  await env.DB.batch([
    headersJson === null
      ? env.DB.prepare(
        "UPDATE messages SET outbound_status = ?, cloudflare_message_id = ?, sent_at = ?, updated_at = ? WHERE id = ?",
      ).bind(state, cloudflareMessageId, null, now, messageId)
      : env.DB.prepare(
        "UPDATE messages SET outbound_status = ?, cloudflare_message_id = ?, headers_json = ?, sent_at = ?, updated_at = ? WHERE id = ?",
      ).bind(state, cloudflareMessageId, headersJson, now, now, messageId),
    env.DB.prepare(
      "UPDATE idempotency_keys SET state = ?, response_json = ?, updated_at = ? WHERE api_key_id = ? AND endpoint = ? AND idempotency_key = ?",
    ).bind(state, JSON.stringify(response), now, keyId, endpoint, idempotencyKey),
  ]);
  if (state === "accepted" && reply) {
    try {
      await acceptedReplyMark(env, {
        originalMessageId: reply.originalMessageId,
        inboxId: reply.inboxId,
        replyMessageId: messageId,
        repliedAt: now,
      }).run();
    } catch (error) {
      // Acceptance is already stored. A marker failure must not become unknown.
      console.error("reply_marker_failed", error instanceof Error ? error.name : "unknown");
    }
  }
  if (state === "accepted") await writeParsedMessageId(env, parsedR2Key, cloudflareMessageId);
}

async function headersWithProviderMessageId(messageId: string, providerId: string | null, env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT headers_json FROM messages WHERE id = ?").bind(messageId).first<{ headers_json: string }>();
  const headers = safeHeaders(row?.headers_json || "{}");
  if (providerId) headers["message-id"] = providerId;
  else delete headers["message-id"];
  return JSON.stringify(headers);
}

async function writeParsedMessageId(env: Env, key: string, messageId: string | null): Promise<void> {
  try {
    const object = await env.MAIL_BUCKET.get(key);
    if (!object) return;
    const parsed = await object.json<Record<string, unknown>>();
    parsed.messageId = messageId;
    await env.MAIL_BUCKET.put(key, JSON.stringify(parsed), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  } catch (error) {
    console.error("outbound_message_id_persist_failed", error instanceof Error ? error.name : "unknown");
  }
}

async function activeInbox(id: string, env: Env): Promise<InboxRow> {
  const inbox = await env.DB.prepare("SELECT * FROM inboxes WHERE id = ? AND active = 1").bind(id).first<InboxRow>();
  if (!inbox) throw new HttpError(404, "not_found", "Active inbox not found");
  if (normalizeDomain(inbox.domain) !== normalizeDomain(env.MAIL_DOMAIN)) {
    throw new HttpError(409, "domain_mismatch", "Inbox does not belong to the configured mail domain");
  }
  return inbox;
}

function optionalBody(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 1_000_000) {
    throw new HttpError(400, "invalid_request", `${field} must be a string no larger than 1,000,000 characters`);
  }
  return value;
}

function validAddress(value: string, field: string): string {
  try {
    return normalizeAddress(value);
  } catch {
    throw new HttpError(400, "invalid_request", `${field} must be a valid email address`);
  }
}

function safeHeaders(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function constantDigest(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

function existingResponse(existing: IdempotencyRow): { status: number; body: unknown } {
  const body = existing.response_json ? JSON.parse(existing.response_json) as unknown : {
    id: existing.outbound_message_id,
    status: existing.state === "started" ? "unknown" : existing.state,
  };
  const status = existing.state === "failed" ? 502 : 202;
  return { status, body };
}

function safeEmailError(error: unknown): { code: string; message: string } {
  const candidate = error as { code?: unknown; message?: unknown };
  return {
    code: typeof candidate?.code === "string" ? candidate.code.slice(0, 100) : "email_send_failed",
    message: typeof candidate?.message === "string" ? candidate.message.slice(0, 500) : "Email service rejected the request",
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
