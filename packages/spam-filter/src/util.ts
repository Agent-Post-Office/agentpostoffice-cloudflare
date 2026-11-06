// Same address shape as the Worker mailbox normalizer, including single-label
// domains such as the inbound invalid-sender placeholder.
const ADDRESS_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

/** Lowercase domain, strip trailing dot. */
export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/** Lowercase and validate an email address. Throws on invalid input. */
export function normalizeAddress(value: string): string {
  const address = value.trim().toLowerCase();
  if (address.length > 254 || !ADDRESS_RE.test(address)) {
    throw new Error("invalid email address");
  }
  return address;
}
