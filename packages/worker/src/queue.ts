import PostalMime from "postal-mime";
import { executeAutomationTask } from "./automation.js";
import type { AttachmentRow, Env, MessageRow, QueueTask } from "./types.js";
import { excerptUtf8, newId, nowIso, sha256Hex } from "./util.js";

export async function handleQueue(batch: MessageBatch<QueueTask>, env: Env): Promise<void> {
  const isDlq = Boolean(env.DLQ_NAME && batch.queue === env.DLQ_NAME);
  const isAutomationDlq = Boolean(env.AUTOMATION_DLQ_NAME && batch.queue === env.AUTOMATION_DLQ_NAME);
  for (const queued of batch.messages) {
    try {
      if (isAutomationDlq && queued.body.kind === "automate") {
        await markAutomationFailed(queued.body, env);
      } else if (isDlq && queued.body.kind === "parse") {
        await markParseFailed(queued.body.messageId, env);
      } else if (queued.body.kind === "automate") {
        await executeAutomationTask(queued.body, env);
      } else if (queued.body.kind === "parse") {
        await parseMessage(queued.body, env);
      } else {
        await deleteMessageObjects(queued.body.messageId, env);
      }
      queued.ack();
    } catch (error) {
      console.error("queue_task_failed", queued.body.kind, queued.id, error instanceof Error ? error.name : "unknown");
      queued.retry();
    }
  }
}

export async function parseMessage(task: Extract<QueueTask, { kind: "parse" }>, env: Env): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT * FROM messages WHERE id = ? AND tombstoned_at IS NULL",
  ).bind(task.messageId).first<MessageRow>();
  if (!row || row.parse_status === "ready") return;

  const rawObject = await env.MAIL_BUCKET.get(task.rawR2Key);
  if (!rawObject) throw new Error("raw message object is missing");
  const raw = await rawObject.arrayBuffer();
  const parsed = await new PostalMime().parse(raw);
  const text = normalizePlainText(parsed.text || "");
  const excerpt = excerptUtf8(text, positiveInteger(env.BODY_EXCERPT_BYTES, 8_192));
  const parsedR2Key = `messages/${row.inbox_id}/${row.id}/parsed.json`;
  const parsedDocument = {
    text,
    html: typeof parsed.html === "string" ? parsed.html : null,
    from: parsed.from || null,
    to: parsed.to || [],
    cc: parsed.cc || [],
    replyTo: parsed.replyTo || [],
    subject: parsed.subject || row.subject,
    messageId: parsed.messageId || null,
    inReplyTo: parsed.inReplyTo || null,
    references: parsed.references || null,
  };
  await env.MAIL_BUCKET.put(parsedR2Key, JSON.stringify(parsedDocument), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  const attachmentRows: AttachmentRow[] = [];
  for (let index = 0; index < parsed.attachments.length; index += 1) {
    const attachment = parsed.attachments[index];
    if (!attachment) continue;
    const attachmentId = deterministicAttachmentId(row.id, index);
    const r2Key = `messages/${row.inbox_id}/${row.id}/attachments/${attachmentId}`;
    const content = typeof attachment.content === "string"
      ? new TextEncoder().encode(attachment.content)
      : attachment.content instanceof ArrayBuffer
        ? new Uint8Array(attachment.content)
        : Uint8Array.from(attachment.content);
    const checksum = await sha256Hex(content);
    await env.MAIL_BUCKET.put(r2Key, content, {
      httpMetadata: { contentType: attachment.mimeType || "application/octet-stream" },
    });
    attachmentRows.push({
      id: attachmentId,
      message_id: row.id,
      r2_key: r2Key,
      filename: attachment.filename || null,
      media_type: attachment.mimeType || "application/octet-stream",
      disposition: attachment.disposition || "attachment",
      size: content.byteLength,
      checksum_sha256: checksum,
      created_at: nowIso(),
    });
  }

  for (const attachment of attachmentRows) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO attachments
       (id, message_id, r2_key, filename, media_type, disposition, size, checksum_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      attachment.id,
      attachment.message_id,
      attachment.r2_key,
      attachment.filename,
      attachment.media_type,
      attachment.disposition,
      attachment.size,
      attachment.checksum_sha256,
      attachment.created_at,
    ).run();
  }

  const replyTo = parsed.replyTo?.[0]?.address || null;
  const headers = JSON.parse(row.headers_json) as Record<string, string>;
  if (parsed.messageId) headers["message-id"] = parsed.messageId;
  if (parsed.inReplyTo) headers["in-reply-to"] = parsed.inReplyTo;
  if (parsed.references) headers.references = parsed.references.slice(0, 8_192);

  const activeScript = await env.DB.prepare(
    "SELECT id, revision FROM sieve_scripts WHERE inbox_id = ? AND active = 1",
  ).bind(row.inbox_id).first<{ id: string; revision: number }>();
  if (activeScript) {
    await env.AUTOMATION_QUEUE.send({
      kind: "automate",
      messageId: row.id,
      scriptId: activeScript.id,
      scriptRevision: activeScript.revision,
    }, { contentType: "json" });
  }

  await env.DB.prepare(
    `UPDATE messages SET subject = ?, reply_to = ?, text_excerpt = ?, body_truncated = ?,
      parsed_r2_key = ?, parse_status = 'ready', headers_json = ?, updated_at = ? WHERE id = ?`,
  ).bind(
    parsed.subject || row.subject,
    replyTo,
    excerpt.text,
    excerpt.truncated ? 1 : 0,
    parsedR2Key,
    JSON.stringify(headers),
    nowIso(),
    row.id,
  ).run();
}

async function markAutomationFailed(task: Extract<QueueTask, { kind: "automate" }>, env: Env): Promise<void> {
  await env.DB.prepare(
    "UPDATE sieve_runs SET state = 'failed', error = 'automation_dlq', updated_at = ? WHERE message_id = ? AND script_id = ? AND script_revision = ? AND state = 'claimed'",
  ).bind(nowIso(), task.messageId, task.scriptId, task.scriptRevision).run();
}

async function markParseFailed(messageId: string, env: Env): Promise<void> {
  await env.DB.prepare(
    "UPDATE messages SET parse_status = 'parse_failed', updated_at = ? WHERE id = ? AND parse_status != 'ready'",
  ).bind(nowIso(), messageId).run();
}

async function deleteMessageObjects(messageId: string, env: Env): Promise<void> {
  const message = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(messageId).first<MessageRow>();
  if (!message) return;
  const attachments = await env.DB.prepare(
    "SELECT * FROM attachments WHERE message_id = ?",
  ).bind(messageId).all<AttachmentRow>();
  const keys = [message.raw_r2_key, message.parsed_r2_key, ...attachments.results.map((item) => item.r2_key)]
    .filter((key): key is string => Boolean(key));
  if (keys.length) await env.MAIL_BUCKET.delete(keys);
  await env.DB.prepare("DELETE FROM attachments WHERE message_id = ?").bind(messageId).run();
  await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(messageId).run();
}

function deterministicAttachmentId(messageId: string, index: number): string {
  return `att_${messageId.replace(/^msg_/, "")}_${index.toString(36).padStart(3, "0")}`;
}

function normalizePlainText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+$/gm, "")
    .trim()
    .normalize("NFC");
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
