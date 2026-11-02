import type { Env } from "./types.js";

/** Cloudflare Email Sending rejects a header value above this many UTF-8 bytes. */
export const EMAIL_HEADER_VALUE_MAX_BYTES = 2048;

const encoder = new TextEncoder();
const MAX_THREAD_LOOKUPS = 16;
const SYNTHETIC_APO_MESSAGE_ID = /^<msg_[0-9a-z]{33,}@[^>\s]+>$/i;

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function messageIdsFromHeader(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((token) => token.replace(/^,+|,+$/g, "").trim())
    .filter((token) => token.length > 0);
}

/**
 * Keep the thread root and the newest ids. Drop whole ids from the oldest
 * middle of the chain so a long thread still fits in one header value.
 * When the root and the newest id cannot both fit, keep the newest id:
 * that is the direct parent mail clients use to place the reply.
 * An id that cannot fit intact is omitted rather than cut in half.
 */
export function trimReferenceIds(ids: string[], maxBytes: number): string | undefined {
  const tokens = ids.map((id) => id.trim()).filter((id) => id.length > 0);
  if (tokens.length === 0 || maxBytes <= 0) return undefined;
  if (utf8ByteLength(tokens.join(" ")) <= maxBytes) return tokens.join(" ");

  const root = tokens[0]!;
  const rest = tokens.slice(1);
  if (rest.length === 0) return utf8ByteLength(root) <= maxBytes ? root : undefined;

  const newest = rest[rest.length - 1]!;
  if (utf8ByteLength(root) <= maxBytes && utf8ByteLength(`${root} ${newest}`) <= maxBytes) {
    const count = largestSuffixThatFits(rest, maxBytes, root);
    return [root, ...rest.slice(rest.length - count)].join(" ");
  }

  const withoutRoot = newestThatFit(rest, maxBytes);
  if (withoutRoot) return withoutRoot;
  return utf8ByteLength(root) <= maxBytes ? root : undefined;
}

export function appendReference(references: string | undefined, messageId: string | undefined): string | undefined {
  const ids = messageIdsFromHeader(references);
  const appended = messageId?.trim();
  if (appended) ids.push(appended);
  return trimReferenceIds(dedupeMessageIds(ids), EMAIL_HEADER_VALUE_MAX_BYTES);
}

export function headerValueWithinLimit(value: string | undefined, maxBytes = EMAIL_HEADER_VALUE_MAX_BYTES): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || utf8ByteLength(trimmed) > maxBytes) return undefined;
  return trimmed;
}

export function providerMessageId(result: { messageId?: string | null } | null | undefined): string | null {
  const value = result?.messageId;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

export function isUnsentSyntheticMessageId(value: string | undefined): boolean {
  return Boolean(value && SYNTHETIC_APO_MESSAGE_ID.test(value.trim()));
}

/**
 * Prefer the id recipients saw. A minted `<msg_...@domain>` header is replaced
 * only when the provider id is stored beside it. Without that id, keep the
 * header: an inbound sender may have used the same shape.
 */
export function threadingMessageId(
  headers: Record<string, string>,
  cloudflareMessageId: string | null | undefined,
): string | undefined {
  const headerId = headers["message-id"]?.trim();
  const providerId = cloudflareMessageId?.trim();
  if (headerId && isUnsentSyntheticMessageId(headerId) && providerId) return providerId;
  return headerId || providerId || undefined;
}

export async function resolveThreadLink(
  env: Env,
  inboxId: string,
  headers: Record<string, string>,
  ownId: string,
): Promise<{ parentMessageId: string | null; threadId: string }> {
  for (const candidate of referenceCandidates(headers)) {
    const parent = await findStoredMessage(env, inboxId, candidate, ownId);
    if (!parent) continue;
    return { parentMessageId: parent.id, threadId: parent.thread_id || parent.id };
  }
  return { parentMessageId: null, threadId: ownId };
}

function referenceCandidates(headers: Record<string, string>): string[] {
  const inReplyTo = messageIdsFromHeader(headers["in-reply-to"] || headers["In-Reply-To"]);
  const references = messageIdsFromHeader(headers.references || headers.References);
  const ordered = [...inReplyTo, ...[...references].reverse()];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ordered) {
    const key = canonicalMessageId(id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(id);
  }
  if (unique.length <= MAX_THREAD_LOOKUPS) return unique;
  const root = references[0];
  const limited = unique.slice(0, MAX_THREAD_LOOKUPS);
  if (root && !limited.some((id) => canonicalMessageId(id) === canonicalMessageId(root))) {
    limited[limited.length - 1] = root;
  }
  return limited;
}

function dedupeMessageIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    const key = canonicalMessageId(id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(id);
  }
  return unique;
}

function canonicalMessageId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">") && trimmed.length > 2) return trimmed.slice(1, -1);
  return trimmed;
}

function messageIdVariants(value: string): [string, string] {
  const trimmed = value.trim();
  const bare = canonicalMessageId(trimmed);
  const bracketed = bare.includes("@") ? `<${bare}>` : trimmed;
  return [trimmed, bracketed === trimmed ? bare : bracketed];
}

interface ThreadParent {
  id: string;
  thread_id: string | null;
}

async function findStoredMessage(
  env: Env,
  inboxId: string,
  rfcId: string,
  excludeId: string,
): Promise<ThreadParent | null> {
  const [first, second] = messageIdVariants(rfcId);
  return env.DB.prepare(
    `SELECT id, thread_id FROM messages
     WHERE inbox_id = ? AND id != ?
       AND (
         cloudflare_message_id = ? OR cloudflare_message_id = ?
         OR json_extract(headers_json, '$."message-id"') = ?
         OR json_extract(headers_json, '$."message-id"') = ?
       )
     ORDER BY received_at DESC, id DESC
     LIMIT 1`,
  ).bind(inboxId, excludeId, first, second, first, second).first<ThreadParent>();
}

function largestSuffixThatFits(ids: string[], maxBytes: number, root?: string): number {
  let low = 0;
  let high = ids.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const selected = root === undefined ? ids.slice(ids.length - mid) : [root, ...ids.slice(ids.length - mid)];
    if (utf8ByteLength(selected.join(" ")) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return low;
}

function newestThatFit(ids: string[], maxBytes: number): string | undefined {
  const count = largestSuffixThatFits(ids, maxBytes);
  if (count === 0) return undefined;
  return ids.slice(ids.length - count).join(" ");
}
