/** APO util subset for reference parity. */
const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
