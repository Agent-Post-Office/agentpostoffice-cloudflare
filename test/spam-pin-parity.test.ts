import { describe, expect, it } from "vitest";
import { scoreSpam, type SpamLists, type SpamScoreInput } from "../packages/worker/src/spam.js";

const EMPTY_LISTS: SpamLists = {
  allowSenders: [],
  blockSenders: [],
  allowDomains: [],
  blockDomains: [],
};

function message(overrides: Partial<SpamScoreInput> & Pick<SpamScoreInput, "from" | "subject" | "text">): SpamScoreInput {
  return {
    authenticationResults: null,
    recipientDomain: "mail.example.com",
    lists: EMPTY_LISTS,
    threshold: 60,
    ...overrides,
  };
}

// These cases are the operator examples in docs/spam-filter.md. The package's
// own parity suite stays in the published repository. This file only checks
// that the worker re-export still returns those scores.
describe("published spam-filter pin", () => {
  it("matches the documented example.com scores", () => {
    const pitched = message({
      from: "person@example.com",
      subject: "We tested your checkout",
      text: "We noticed a problem. Got 15 minutes?",
      authenticationResults: "mx.example.com; dkim=pass; spf=pass; dmarc=fail",
    });
    expect(scoreSpam(pitched)).toEqual({
      score: 89,
      reasons: ["auth_dmarc_fail", "cold_audit", "outreach_opener", "meeting_ask"],
      verdict: "spam",
    });
    expect(scoreSpam({
      ...pitched,
      authenticationResults: "mx.example.com; dkim=pass; spf=pass; dmarc=pass",
    })).toEqual({
      score: 49,
      reasons: ["cold_audit", "outreach_opener", "meeting_ask"],
      verdict: "ham",
    });
    expect(scoreSpam({
      ...pitched,
      text: "A short note.",
    })).toEqual({
      score: 59,
      reasons: ["auth_dmarc_fail", "cold_audit"],
      verdict: "ham",
    });
    expect(scoreSpam(message({
      from: "person@example.com",
      subject: "Hello",
      text: "A short note.",
      authenticationResults: "mx.example.com; dkim=pass; spf=fail; dmarc=fail",
    }))).toEqual({
      score: 60,
      reasons: ["auth_dmarc_fail", "auth_spf_fail"],
      verdict: "spam",
    });
    expect(scoreSpam(message({
      from: "person@example.com",
      subject: "Hello",
      text: "A short note.",
      authenticationResults: "mx.example.com; dkim=pass; spf=pass; dmarc=fail",
    }))).toEqual({
      score: 40,
      reasons: ["auth_dmarc_fail"],
      verdict: "ham",
    });
  });

  it("matches a block rule for the single-label invalid-sender placeholder", () => {
    expect(scoreSpam(message({
      from: "invalid-sender@invalid",
      subject: "Hello",
      text: "A short note.",
      lists: { ...EMPTY_LISTS, blockSenders: ["invalid-sender@invalid"] },
    }))).toEqual({ score: 100, reasons: ["block_sender"], verdict: "spam" });
  });
});
