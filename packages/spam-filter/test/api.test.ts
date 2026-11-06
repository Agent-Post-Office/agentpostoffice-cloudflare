import { describe, expect, it } from "vitest";
import {
  CONTENT_RULE_WEIGHTS,
  DEFAULT_SPAM_THRESHOLD,
  BAYES_CAP,
  DEFAULT_SPAM_LEARN_MIN,
  parseAuthenticationResults,
  scoreMessage,
  tokenizeMessage,
  spamProbabilityFromStore,
  scoreWithStore,
  type SpamStore,
  type SpamLists,
} from "../src/index.js";

describe("public API", () => {
  it("parseAuthenticationResults prefers pass over fail when both appear", () => {
    const auth = parseAuthenticationResults(
      "mx.cloudflare.net; dkim=fail; dkim=pass; spf=softfail; dmarc=fail",
    );
    expect(auth.dkim).toBe("pass");
    expect(auth.spf).toBe("softfail");
    expect(auth.dmarc).toBe("fail");
  });

  it("scoreMessage defaults lists and threshold", () => {
    const result = scoreMessage({
      from: "sales@mg.example.net",
      subject: "We tested your MCP server",
      text: "We noticed a problem. Got 15 minutes?",
      authenticationResults: null,
      recipientDomain: "mail.example.com",
    });
    expect(result.verdict).toBe("spam");
    expect(result.score).toBe(
      CONTENT_RULE_WEIGHTS.cold_audit
        + CONTENT_RULE_WEIGHTS.outreach_opener
        + CONTENT_RULE_WEIGHTS.meeting_ask
        + CONTENT_RULE_WEIGHTS.marketing_subdomain,
    );
    expect(result.score).toBe(61);
    expect(result.score).toBeGreaterThanOrEqual(DEFAULT_SPAM_THRESHOLD);
  });

  it("caps every content weight at 19", () => {
    for (const [rule, weight] of Object.entries(CONTENT_RULE_WEIGHTS)) {
      expect(weight, rule).toBeLessThanOrEqual(19);
    }
  });

  it("exposes tokenizeMessage for host training parity", () => {
    const tokens = tokenizeMessage({
      subject: "Account notice",
      text: "Visit https://Track.Example.TEST/path",
      from: "Person <Person@Example.TEST>",
    });
    expect(tokens[0]).toBe("domain:example.test");
    expect(tokens).toContain("host:track.example.test");
  });

  it("SpamStore loads Bayes through getClassCounts and getTokenCounts", async () => {
    const empty: SpamLists = {
      allowSenders: [],
      blockSenders: [],
      allowDomains: [],
      blockDomains: [],
    };
    const store: SpamStore = {
      getRules: () => empty,
      getClassCounts: () => ({ spamMessages: 0, hamMessages: 0 }),
      getTokenCounts: () => new Map(),
    };
    const probability = await spamProbabilityFromStore(
      store,
      "inb_example",
      { from: "a@example.com", subject: "Hi", text: "Hello there" },
      DEFAULT_SPAM_LEARN_MIN,
    );
    expect(probability).toBeNull();
    const scored = await scoreWithStore(store, "inb_example", {
      from: "a@example.com",
      subject: "Hi",
      text: "Hello there",
      authenticationResults: null,
      recipientDomain: "example.com",
      learn: true,
    });
    expect(scored.spamProbability).toBeNull();
    expect(scored.assessment.score).toBe(0);
    expect(BAYES_CAP).toBe(52);
  });
});
