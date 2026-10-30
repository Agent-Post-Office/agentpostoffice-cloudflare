import { describe, expect, it } from "vitest";
import { appendReference, EMAIL_HEADER_VALUE_MAX_BYTES, messageIdsFromHeader } from "../packages/worker/src/threading.js";

const encoder = new TextEncoder();

function referenceId(index: number): string {
  return `<m${String(index).padStart(4, "0")}-${"x".repeat(20)}@example.net>`;
}

describe("References header trimming", () => {
  it("matches the Cloudflare Email Sending per-header byte cap", () => {
    expect(EMAIL_HEADER_VALUE_MAX_BYTES).toBe(2048);
  });

  it("keeps a short chain intact, including the appended parent id", () => {
    expect(appendReference("<root@example.net> <mid@example.net>", "<new@example.net>")).toBe(
      "<root@example.net> <mid@example.net> <new@example.net>",
    );
  });

  it("drops the oldest middle ids once the chain exceeds 2048 bytes", () => {
    const ids = Array.from({ length: 120 }, (_, index) => referenceId(index));
    const trimmed = appendReference(ids.slice(0, -1).join(" "), ids.at(-1));
    expect(trimmed).toBeTruthy();
    const tokens = trimmed!.split(" ");
    expect(encoder.encode(trimmed!).byteLength).toBeLessThanOrEqual(EMAIL_HEADER_VALUE_MAX_BYTES);
    expect(tokens[0]).toBe(ids[0]);
    expect(tokens.at(-1)).toBe(ids.at(-1));
    expect(tokens).not.toContain(ids[1]);
    expect(tokens.every((token) => ids.includes(token))).toBe(true);
    expect(encoder.encode(ids.join(" ")).byteLength).toBeGreaterThan(EMAIL_HEADER_VALUE_MAX_BYTES);
  });

  it("still trims an already oversized References value when there is no new id", () => {
    const ids = Array.from({ length: 120 }, (_, index) => referenceId(index));
    const trimmed = appendReference(ids.join(" "), undefined);
    const tokens = trimmed!.split(" ");
    expect(encoder.encode(trimmed!).byteLength).toBeLessThanOrEqual(2048);
    expect(tokens[0]).toBe(ids[0]);
    expect(tokens.at(-1)).toBe(ids.at(-1));
    expect(tokens).not.toContain(ids[1]);
  });

  it("keeps the newest id when the root and the direct parent cannot both fit", () => {
    const newest = "<parent@example.net>";
    const root = `<${"r".repeat(2048 - newest.length - 4)}@x>`;
    const bulkyMiddle = `<${"m".repeat(2048 - newest.length - 4)}@x>`;
    expect(encoder.encode(root).byteLength).toBeLessThanOrEqual(2048);
    expect(encoder.encode(`${root} ${newest}`).byteLength).toBeGreaterThan(2048);
    expect(encoder.encode(`${bulkyMiddle} ${newest}`).byteLength).toBeGreaterThan(2048);

    const onlyParent = appendReference(`${root} ${bulkyMiddle}`, newest);
    expect(onlyParent).toBe(newest);
    expect(onlyParent).not.toContain(root);

    const withSmallMiddle = appendReference(`${root} <mid@example.net>`, newest);
    expect(withSmallMiddle).toBe(`<mid@example.net> ${newest}`);
    expect(encoder.encode(withSmallMiddle!).byteLength).toBeLessThanOrEqual(2048);
  });

  it("keeps a chain that is exactly 2048 bytes and trims one byte past it", () => {
    const newest = "<n@example.net>";
    const root = `<${"a".repeat(2048 - newest.length - 1 - 4)}@x>`;
    const exact = `${root} ${newest}`;
    expect(encoder.encode(exact).byteLength).toBe(2048);
    expect(appendReference(root, newest)).toBe(exact);

    const longerRoot = `<${"a".repeat(2048 - newest.length - 4)}@x>`;
    expect(encoder.encode(`${longerRoot} ${newest}`).byteLength).toBe(2049);
    expect(encoder.encode(longerRoot).byteLength).toBeLessThanOrEqual(2048);
    expect(appendReference(longerRoot, newest)).toBe(newest);

    const exactId = `<${"b".repeat(2044)}@x>`;
    expect(encoder.encode(exactId).byteLength).toBe(2048);
    expect(appendReference(exactId, undefined)).toBe(exactId);
    expect(appendReference(`<${"b".repeat(2045)}@x>`, undefined)).toBeUndefined();
  });

  it("splits comma-joined References and strips stray commas", () => {
    const headers = new Headers();
    headers.append("references", "<a@x>");
    headers.append("references", "<b@x>");
    expect(headers.get("references")).toBe("<a@x>, <b@x>");
    expect(messageIdsFromHeader(headers.get("references") ?? undefined)).toEqual(["<a@x>", "<b@x>"]);
    expect(messageIdsFromHeader("<a@x>,<b@x>")).toEqual(["<a@x>", "<b@x>"]);
    expect(messageIdsFromHeader("<a@x>, , <b@x>,")).toEqual(["<a@x>", "<b@x>"]);
    expect(appendReference("<a@x>, <b@x>", "<c@x>")).toBe("<a@x> <b@x> <c@x>");
  });

  it("does not append a References id that is already present", () => {
    expect(appendReference("<root@example.net> <mid@example.net>", "<mid@example.net>")).toBe(
      "<root@example.net> <mid@example.net>",
    );
    expect(appendReference("<root@example.net> <root@example.net>", "root@example.net")).toBe("<root@example.net>");
  });

  it("counts UTF-8 bytes rather than JavaScript characters", () => {
    const wide = `<${"é".repeat(1100)}@example.net>`;
    const recent = "<new@example.net>";
    expect(wide.length).toBeLessThan(2048);
    expect(encoder.encode(wide).byteLength).toBeGreaterThan(2048);
    expect(appendReference(wide, recent)).toBe(recent);
  });

  it("omits a chain when no intact id fits", () => {
    const huge = `<${"a".repeat(2100)}@example.net>`;
    expect(appendReference(huge, undefined)).toBeUndefined();
  });

  it("returns nothing for an empty chain", () => {
    expect(appendReference(undefined, undefined)).toBeUndefined();
    expect(appendReference("   ", "  ")).toBeUndefined();
  });
});
