import { HttpError, requireString } from "./http.js";
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
  const originalMessageId = headers["message-id"];
  const references = appendReference(headers.references, originalMessageId);
  const subject = /^re:/i.test(original.subject || "") ? original.subject || "Re:" : `Re: ${original.subject || ""}`;
  return deliver(
    {
      inbox,
      recipient,
      subject,
      text,
      html,
      headers: {
        ...(originalMessageId ? { "In-Reply-To": originalMessageId } : {}),
        ...(references ? { References: references } : {}),
      },
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
  const outboundRfcMessageId = `<${messageId}@${normalizeDomain(env.MAIL_DOMAIN)}>`;
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
    messageId: outboundRfcMessageId,
    inReplyTo: mail.headers?.["In-Reply-To"] || null,
    references: mail.headers?.References || null,
  }), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  await env.DB.prepare(
    `INSERT INTO messages (
      id, inbox_id, direction, envelope_from, envelope_to, subject, text_excerpt, parsed_r2_key,
      body_truncated, parse_status, agent_state, labels_json, headers_json,
      outbound_status, received_at, created_at, updated_at
    ) VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, 'not_applicable', 'processed', '[]', ?, 'pending', ?, ?, ?)`,
  ).bind(
    messageId,
    mail.inbox.id,
    fromAddress,
    mail.recipient,
    mail.subject,
    excerpt.text,
    parsedR2Key,
    excerpt.truncated ? 1 : 0,
    JSON.stringify({ "message-id": outboundRfcMessageId, ...(mail.headers || {}) }),
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
    const response = { id: messageId, status: "accepted", cloudflare_message_id: result.messageId };
    try {
      await persistOutboundState(messageId, auth.keyId, endpoint, idempotencyKey, "accepted", response, result.messageId, env);
      return { status: 202, body: response };
    } catch {
      const unknown = { id: messageId, status: "unknown" };
      try {
        await persistOutboundState(messageId, auth.keyId, endpoint, idempotencyKey, "unknown", unknown, null, env);
      } catch {
        // The client still receives unknown and must not retry with a new key.
      }
      return { status: 202, body: unknown };
    }
  } catch (error) {
    const response = { id: messageId, status: "failed", error: safeEmailError(error) };
    await persistOutboundState(messageId, auth.keyId, endpoint, idempotencyKey, "failed", response, null, env);
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
  },
  env: Env,
): Promise<{ messageId: string; providerMessageId: string }> {
  const messageId = newId("msg");
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
      outbound_status, received_at, created_at, updated_at
    ) VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, 'not_applicable', 'processed', '[]', ?, 'pending', ?, ?, ?)`,
  ).bind(
    messageId, mail.inbox.id, fromAddress, mail.recipient, mail.subject, excerpt.text, parsedR2Key,
    excerpt.truncated ? 1 : 0, JSON.stringify(mail.headers), now, now, now,
  ).run();
  try {
    const result = await sendEmail({
      to: mail.recipient,
      from: mail.inbox.display_name ? { email: fromAddress, name: mail.inbox.display_name } : fromAddress,
      subject: mail.subject,
      text: mail.text,
      headers: mail.headers,
    }, env);
    await env.DB.prepare(
      "UPDATE messages SET outbound_status = 'accepted', cloudflare_message_id = ?, sent_at = ?, updated_at = ? WHERE id = ?",
    ).bind(result.messageId, nowIso(), nowIso(), messageId).run();
    return { messageId, providerMessageId: result.messageId };
  } catch (error) {
    await env.DB.prepare(
      "UPDATE messages SET outbound_status = 'failed', updated_at = ? WHERE id = ?",
    ).bind(nowIso(), messageId).run();
    throw error;
  }
}

async function persistOutboundState(
  messageId: string,
  keyId: string,
  endpoint: string,
  idempotencyKey: string,
  state: "accepted" | "failed" | "unknown",
  response: unknown,
  cloudflareMessageId: string | null,
  env: Env,
): Promise<void> {
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE messages SET outbound_status = ?, cloudflare_message_id = ?, sent_at = ?, updated_at = ? WHERE id = ?",
    ).bind(state, cloudflareMessageId, state === "accepted" ? now : null, now, messageId),
    env.DB.prepare(
      "UPDATE idempotency_keys SET state = ?, response_json = ?, updated_at = ? WHERE api_key_id = ? AND endpoint = ? AND idempotency_key = ?",
    ).bind(state, JSON.stringify(response), now, keyId, endpoint, idempotencyKey),
  ]);
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

function appendReference(references: string | undefined, messageId: string | undefined): string | undefined {
  if (!messageId) return references;
  const values = `${references || ""} ${messageId}`.trim().split(/\s+/).slice(-100);
  return values.join(" ").slice(-8_192);
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
