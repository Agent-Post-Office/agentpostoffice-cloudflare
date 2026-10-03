import { compileSieve, evaluateSieve } from "@agentpostoffice/sieve";
import { sendAutomationReply } from "./outbound.js";
import type { Env, InboxRow, MessageRow, QueueTask } from "./types.js";
import { newId, normalizeAddress, nowIso } from "./util.js";

interface SieveScriptRow {
  id: string;
  inbox_id: string;
  revision: number;
  source: string;
  active: number;
}

export async function executeAutomationTask(
  task: Extract<QueueTask, { kind: "automate" }>,
  env: Env,
): Promise<void> {
  const message = await env.DB.prepare(
    "SELECT * FROM messages WHERE id = ? AND direction = 'inbound' AND parse_status = 'ready' AND tombstoned_at IS NULL",
  ).bind(task.messageId).first<MessageRow>();
  if (!message) return;
  const script = await env.DB.prepare(
    "SELECT id, inbox_id, revision, source, active FROM sieve_scripts WHERE id = ? AND inbox_id = ? AND revision = ?",
  ).bind(task.scriptId, message.inbox_id, task.scriptRevision).first<SieveScriptRow>();
  if (!script) return;
  const inbox = await env.DB.prepare("SELECT * FROM inboxes WHERE id = ? AND active = 1")
    .bind(message.inbox_id).first<InboxRow>();
  if (!inbox) return;
  const headers = safeHeaders(message.headers_json);
  const recipient = await automationRecipient(message, env);
  if (!recipient || unsafeAutomaticSender(recipient, inbox, headers)) return;
  const plan = evaluateSieve(compileSieve(script.source), {
    envelopeFrom: message.envelope_from,
    envelopeTo: message.envelope_to,
    headers: { subject: message.subject || "", ...headers },
    size: 0,
  });
  if (!plan) return;

  const now = nowIso();
  const claimed = await env.DB.prepare(
    `INSERT OR IGNORE INTO sieve_runs
      (id, message_id, script_id, script_revision, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'claimed', ?, ?)`,
  ).bind(newId("run"), message.id, script.id, script.revision, now, now).run();
  if ((claimed.meta.changes ?? 0) === 0) return;

  const sender = recipient;
  const previous = await env.DB.prepare(
    "SELECT last_sent_at FROM sieve_vacation_responses WHERE inbox_id = ? AND handle = ? AND sender_address = ?",
  ).bind(inbox.id, plan.handle, sender).first<{ last_sent_at: string }>();
  if (previous && Date.now() - Date.parse(previous.last_sent_at) < plan.days * 86_400_000) return;
  await env.DB.prepare(
    `INSERT INTO sieve_vacation_responses (inbox_id, handle, sender_address, last_sent_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(inbox_id, handle, sender_address) DO UPDATE SET last_sent_at = excluded.last_sent_at`,
  ).bind(inbox.id, plan.handle, sender, now).run();

  const originalMessageId = headers["message-id"];
  const references = appendReference(headers.references, originalMessageId);
  try {
    await sendAutomationReply({
      inbox,
      recipient: sender,
      subject: plan.subject || defaultReplySubject(message.subject),
      text: plan.reason,
      headers: {
        "Auto-Submitted": "auto-replied",
        "X-Agent-Post-Office-Automation": `${script.id}/${script.revision}`,
        ...(originalMessageId ? { "In-Reply-To": originalMessageId } : {}),
        ...(references ? { References: references } : {}),
      },
    }, env);
    await env.DB.batch([
      env.DB.prepare("UPDATE sieve_runs SET state = 'sent', updated_at = ? WHERE message_id = ? AND script_id = ? AND script_revision = ?")
        .bind(nowIso(), message.id, script.id, script.revision),
      env.DB.prepare("UPDATE messages SET agent_state = 'processed', updated_at = ? WHERE id = ?")
        .bind(nowIso(), message.id),
    ]);
  } catch (error) {
    await env.DB.batch([
      env.DB.prepare("UPDATE sieve_runs SET state = 'failed', error = ?, updated_at = ? WHERE message_id = ? AND script_id = ? AND script_revision = ?")
        .bind(error instanceof Error ? error.name.slice(0, 100) : "send_failed", nowIso(), message.id, script.id, script.revision),
      env.DB.prepare("DELETE FROM sieve_vacation_responses WHERE inbox_id = ? AND handle = ? AND sender_address = ?")
        .bind(inbox.id, plan.handle, sender),
    ]);
  }
}

function unsafeAutomaticSender(sender: string, inbox: InboxRow, headers: Record<string, string>): boolean {
  if (!sender || sender === `${inbox.local_part}@${inbox.domain}`) return true;
  if ((headers["auto-submitted"] || "no").toLowerCase() !== "no") return true;
  if (["bulk", "list", "junk"].includes((headers.precedence || "").toLowerCase())) return true;
  if (Object.keys(headers).some((name) => name.startsWith("list-"))) return true;
  const local = sender.slice(0, sender.lastIndexOf("@")).toLowerCase();
  return local === "mailer-daemon" || local === "listserv" || local === "majordomo" || local.startsWith("owner-") || local.endsWith("-request");
}

async function automationRecipient(message: MessageRow, env: Env): Promise<string | null> {
  let envelope: string;
  try { envelope = normalizeAddress(message.envelope_from); } catch { return null; }
  const envelopeDomain = envelope.slice(envelope.lastIndexOf("@") + 1);
  if (!envelopeDomain.startsWith("cf-bounce.")) return envelope;
  if (!message.parsed_r2_key) return null;
  const object = await env.MAIL_BUCKET.get(message.parsed_r2_key);
  if (!object) return null;
  const parsed = await object.json<{ from?: { address?: unknown } }>();
  if (typeof parsed.from?.address !== "string") return null;
  let visible: string;
  try { visible = normalizeAddress(parsed.from.address); } catch { return null; }
  const visibleDomain = visible.slice(visible.lastIndexOf("@") + 1);
  return visibleDomain === envelopeDomain.slice("cf-bounce.".length) ? visible : null;
}

function safeHeaders(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([name, header]) => [name.toLowerCase(), header]));
  } catch { return {}; }
}

function defaultReplySubject(subject: string | null): string {
  return /^re:/i.test(subject || "") ? subject || "Re:" : `Re: ${subject || ""}`;
}

function appendReference(references: string | undefined, messageId: string | undefined): string | undefined {
  if (!messageId) return references;
  return `${references || ""} ${messageId}`.trim().split(/\s+/).slice(-100).join(" ").slice(-8_192);
}
