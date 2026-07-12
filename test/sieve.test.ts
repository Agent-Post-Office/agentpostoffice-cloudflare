import { describe, expect, it } from "vitest";
import { compileSieve, evaluateSieve, SieveValidationError } from "../packages/sieve/src/index.js";

const welcomeScript = `
require ["envelope", "vacation"];

if allof (
  envelope :is "to" "itworks@agentpostoffice.com",
  header :is "subject" "Agent Post Office installation check"
) {
  vacation :days 365 :handle "installation-welcome-v1" :subject "It works"
    "Welcome to Agent Post Office.";
  stop;
}
`;

describe("Agent Post Office Sieve autoresponder profile", () => {
  it("compiles and evaluates the envelope plus vacation profile", () => {
    const compiled = compileSieve(welcomeScript);
    expect(evaluateSieve(compiled, {
      envelopeFrom: "person@example.net",
      envelopeTo: "itworks@agentpostoffice.com",
      headers: { subject: "Agent Post Office installation check" },
      size: 120,
    })).toEqual({
      kind: "vacation",
      days: 365,
      handle: "installation-welcome-v1",
      subject: "It works",
      reason: "Welcome to Agent Post Office.",
    });
  });

  it("returns no action when a condition does not match", () => {
    const compiled = compileSieve(welcomeScript);
    expect(evaluateSieve(compiled, {
      envelopeFrom: "person@example.net",
      envelopeTo: "itworks@agentpostoffice.com",
      headers: { subject: "Something else" },
      size: 120,
    })).toBeNull();
  });

  it("rejects capabilities and delivery actions outside the profile", () => {
    expect(() => compileSieve('require ["redirect"]; redirect "victim@example.net";'))
      .toThrow(SieveValidationError);
    expect(() => compileSieve('require ["body"]; if body :contains "secret" { stop; }'))
      .toThrow(/unsupported/i);
    expect(() => compileSieve('require ["envelope"]; if envelope :regex "to" ".*" { stop; }'))
      .toThrow(/unsupported/i);
  });

  it("enforces bounded source and nesting", () => {
    expect(() => compileSieve("#".repeat(65_537))).toThrow(/64 KiB/i);
    const nested = `${"if true {".repeat(33)}${"}".repeat(33)}`;
    expect(() => compileSieve(nested)).toThrow(/nesting/i);
  });
});
