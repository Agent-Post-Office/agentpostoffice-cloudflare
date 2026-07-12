const ADDRESS_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
const LOCAL_PART_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/i;

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

export function normalizeAddress(value: string): string {
  const address = value.trim().toLowerCase();
  if (address.length > 254 || !ADDRESS_RE.test(address)) {
    throw new Error("invalid email address");
  }
  return address;
}

export function normalizeLocalPart(value: string): string {
  const localPart = value.trim().toLowerCase();
  if (!LOCAL_PART_RE.test(localPart)) {
    throw new Error("invalid mailbox local part");
  }
  return localPart;
}

export function newId(prefix: "inb" | "msg" | "att" | "siv" | "run"): string {
  const time = Date.now().toString(36).padStart(9, "0");
  const random = crypto.getRandomValues(new Uint8Array(12));
  const suffix = [...random].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${time}${suffix}`;
}

export async function sha256Hex(value: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value instanceof Uint8Array
      ? value
      : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

export function excerptUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return { text: text.slice(0, low), truncated: true };
}

export function encodeCursor(receivedAt: string, messageId: string): string {
  return base64UrlEncode(JSON.stringify({ receivedAt, messageId }));
}

export function decodeCursor(value: string): { receivedAt: string; messageId: string } {
  try {
    const parsed = JSON.parse(base64UrlDecode(value)) as Record<string, unknown>;
    if (typeof parsed.receivedAt !== "string" || typeof parsed.messageId !== "string") throw new Error();
    return { receivedAt: parsed.receivedAt, messageId: parsed.messageId };
  } catch {
    throw new Error("invalid cursor");
  }
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

export function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
