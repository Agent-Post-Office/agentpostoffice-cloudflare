import type { Env, InboxRow, QueueTask } from "./types.js";
import { newId, normalizeAddress, normalizeDomain, nowIso } from "./util.js";

export interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream;
  readonly rawSize: number;
  setReject(reason: string): void;
}

export async function handleInbound(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const maxBytes = positiveInteger(env.MAX_INBOUND_BYTES, 10 * 1024 * 1024);
  let recipient: string;
  try {
    recipient = normalizeAddress(message.to);
  } catch {
    message.setReject("Invalid recipient");
    return;
  }

  const separator = recipient.lastIndexOf("@");
  const localPart = recipient.slice(0, separator);
  const domain = normalizeDomain(recipient.slice(separator + 1));
  if (domain !== normalizeDomain(env.MAIL_DOMAIN)) {
    message.setReject("Recipient domain is not configured");
    return;
  }

  const inbox = await env.DB.prepare(
    "SELECT * FROM inboxes WHERE domain = ? AND local_part = ? AND active = 1",
  ).bind(domain, localPart).first<InboxRow>();
  if (!inbox) {
    message.setReject("Unknown or disabled recipient");
    return;
  }
  if (message.rawSize > maxBytes) {
    message.setReject("Message exceeds the configured size limit");
    return;
  }

  const messageId = newId("msg");
  const rawR2Key = `messages/${inbox.id}/${messageId}/raw.eml`;
  const now = nowIso();
  const sender = safeAddress(message.from);
  const subject = boundedHeader(message.headers.get("subject"), 998);
  const headers = selectedHeaders(message.headers);
  const rawBytes = await new Response(message.raw).arrayBuffer();
  if (rawBytes.byteLength !== message.rawSize) {
    throw new Error("Inbound message size changed while reading the raw stream");
  }

  // Infrastructure errors intentionally escape. Phase 0 must confirm Cloudflare
  // treats this as a temporary SMTP failure; setReject is reserved for permanent
  // policy failures such as unknown recipients and oversize messages.
  // R2 rejects arbitrary ReadableStreams because they do not carry a known
  // length. Materializing the already size-bounded message preserves exact
  // bytes and gives R2 an accepted fixed-size body.
  await env.MAIL_BUCKET.put(rawR2Key, rawBytes, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: { messageId, inboxId: inbox.id },
  });

  try {
    await env.DB.prepare(
      `INSERT INTO messages (
        id, inbox_id, direction, envelope_from, envelope_to, subject,
        raw_r2_key, parse_status, agent_state, labels_json, headers_json,
        received_at, created_at, updated_at
      ) VALUES (?, ?, 'inbound', ?, ?, ?, ?, 'pending', 'unprocessed', '[]', ?, ?, ?, ?)`,
    ).bind(
      messageId,
      inbox.id,
      sender,
      recipient,
      subject,
      rawR2Key,
      JSON.stringify(headers),
      now,
      now,
      now,
    ).run();

    const task: QueueTask = { kind: "parse", messageId, rawR2Key };
    await env.MAIL_QUEUE.send(task, { contentType: "json" });
  } catch (error) {
    // The raw object can be orphaned by design. Do not acknowledge SMTP after a
    // partial persistence failure; the sender must be allowed to retry.
    console.error("inbound_persistence_failed", messageId, error instanceof Error ? error.name : "unknown");
    throw error;
  }
}

function selectedHeaders(headers: Headers): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of ["message-id", "in-reply-to", "references", "reply-to", "date"]) {
    const value = headers.get(name);
    if (value) selected[name] = value.slice(0, 8_192);
  }
  return selected;
}

function safeAddress(value: string): string {
  try {
    return normalizeAddress(value);
  } catch {
    return "invalid-sender@invalid";
  }
}

function boundedHeader(value: string | null, maximum: number): string | null {
  return value ? value.replace(/[\r\n]+/g, " ").slice(0, maximum) : null;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
