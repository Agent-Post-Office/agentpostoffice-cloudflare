import { describe, expect, it } from "vitest";
import { appendReference, EMAIL_HEADER_VALUE_MAX_BYTES } from "../packages/worker/src/threading.js";

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
