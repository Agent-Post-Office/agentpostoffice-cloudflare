import { describe, expect, it } from "vitest";
import {
  AUTH_FAILURE_WEIGHTS,
  CONTENT_RULE_WEIGHTS,
  DEFAULT_SPAM_MODE,
  DEFAULT_SPAM_THRESHOLD,
  applySpamFilter,
  resolveSpamConfig,
  scoreSpam,
  verdictForScore,
  type SpamLists,
  type SpamScoreInput,
} from "../src/index.js";

const EMPTY_LISTS: SpamLists = {
  allowSenders: [],
  blockSenders: [],
  allowDomains: [],
  blockDomains: [],
};

const PASSING_AUTH = "mx.cloudflare.net; dkim=pass header.d=example.test header.s=s1; spf=pass smtp.mailfrom=bounce@example.test; dmarc=pass header.from=example.test";

describe("spam rules scorer", () => {
  it("scores the reported pitches under the threshold and leaves a security report alone", () => {
    const coldAudit = scoreSpam(message({
      from: "sales@mg.example.com",
      subject: "We tested your MCP server",
      text: "We tested your MCP server and wanted to share what we found.",
      authenticationResults: PASSING_AUTH.replaceAll("example.test", "mg.example.com"),
    }));
    const downtimePitch = scoreSpam(message({
      from: "hello@vendor.example.net",
      subject: "Downtime at mcp.customer.example",
      text: "We noticed downtime at mcp.customer.example. Got 15 minutes to walk through it?",
      authenticationResults: PASSING_AUTH.replaceAll("example.test", "vendor.example.net"),
    }));
    const verification = scoreSpam(message({
      from: "notice@gmail.com",
      subject: "Important Notice: Email Address Verification",
      text: "",
      authenticationResults: PASSING_AUTH.replaceAll("example.test", "gmail.com"),
    }));
    const securityReport = scoreSpam(message({
      from: "researcher@example.org",
      subject: "Who handles security reports?",
      text: "Hello, I found a problem in the public MCP endpoint and need to know who handles security reports before I send the write-up.",
      authenticationResults: PASSING_AUTH.replaceAll("example.test", "example.org"),
    }));

    expect(coldAudit).toEqual({
      score: CONTENT_RULE_WEIGHTS.cold_audit + CONTENT_RULE_WEIGHTS.marketing_subdomain,
      reasons: ["cold_audit", "marketing_subdomain"],
      verdict: "ham",
    });
    expect(downtimePitch).toEqual({
      score: CONTENT_RULE_WEIGHTS.outreach_opener + CONTENT_RULE_WEIGHTS.meeting_ask + CONTENT_RULE_WEIGHTS.unrelated_incident,
      reasons: ["outreach_opener", "meeting_ask", "unrelated_incident"],
      verdict: "ham",
    });
    expect(verification).toEqual({
      score: CONTENT_RULE_WEIGHTS.verification_subject
        + CONTENT_RULE_WEIGHTS.urgency_notice
        + CONTENT_RULE_WEIGHTS.freemail_verification
        + CONTENT_RULE_WEIGHTS.empty_verification_body,
      reasons: ["verification_subject", "urgency_notice", "freemail_verification", "empty_verification_body"],
      verdict: "ham",
    });
    for (const result of [coldAudit, downtimePitch, verification]) {
      expect(result.score).toBeLessThan(DEFAULT_SPAM_THRESHOLD);
      expect(result.reasons.some((reason) => reason.startsWith("auth_"))).toBe(false);
    }
    expect(securityReport).toEqual({ score: 0, reasons: [], verdict: "ham" });
  });

  it("keeps every content rule under the threshold alone and with one auth failure", () => {
    const content = Object.entries(CONTENT_RULE_WEIGHTS);
    const failures = Object.entries(AUTH_FAILURE_WEIGHTS);
    expect(content).toHaveLength(9);
    expect(failures).toHaveLength(4);
    expect(Math.max(...failures.map(([, points]) => points))).toBe(AUTH_FAILURE_WEIGHTS.auth_dmarc_fail);
    for (const [rule, weight] of content) {
      expect(weight, rule).toBeGreaterThan(0);
      expect(weight, rule).toBeLessThan(DEFAULT_SPAM_THRESHOLD);
      for (const [failure, points] of failures) {
        expect(weight + points, `${rule} + ${failure}`).toBeLessThan(DEFAULT_SPAM_THRESHOLD);
      }
    }
  });

  it("flags a message when several content signals agree", () => {
    const scored = scoreSpam(message({
      from: "sales@mg.example.net",
      subject: "We tested your MCP server",
      text: "We noticed a problem. Got 15 minutes?",
      authenticationResults: null,
    }));
    const score = CONTENT_RULE_WEIGHTS.cold_audit
      + CONTENT_RULE_WEIGHTS.outreach_opener
      + CONTENT_RULE_WEIGHTS.meeting_ask
      + CONTENT_RULE_WEIGHTS.marketing_subdomain;
    expect(scored).toEqual({
      score,
      reasons: ["cold_audit", "outreach_opener", "meeting_ask", "marketing_subdomain"],
      verdict: "spam",
    });
    expect(score).toBeGreaterThanOrEqual(DEFAULT_SPAM_THRESHOLD);
  });

  it("does not let a passing Authentication-Results header decide the verdict", () => {
    const withoutAuth = scoreSpam(message({
      from: "sales@mg.example.com",
      subject: "We tested your MCP server",
      text: "We tested your MCP server and wanted to share what we found.",
      authenticationResults: null,
    }));
    const withAuth = scoreSpam(message({
      from: "sales@mg.example.com",
      subject: "We tested your MCP server",
      text: "We tested your MCP server and wanted to share what we found.",
      authenticationResults: PASSING_AUTH.replaceAll("example.test", "mg.example.com"),
    }));
    const ham = scoreSpam(message({
      from: "researcher@example.org",
      subject: "Who handles security reports?",
      text: "Who handles security reports for this mailbox?",
      authenticationResults: PASSING_AUTH,
    }));

    expect(withAuth).toEqual(withoutAuth);
    expect(withAuth.verdict).toBe("ham");
    expect(withAuth.score).toBe(CONTENT_RULE_WEIGHTS.cold_audit + CONTENT_RULE_WEIGHTS.marketing_subdomain);
    expect(ham.verdict).toBe("ham");
    expect(ham.score).toBe(0);
  });

  it("adds score for authentication failures without treating a single failure as enough", () => {
    const dmarcOnly = scoreSpam(message({
      from: "person@example.net",
      subject: "Hello",
      text: "Just saying hi.",
      authenticationResults: "mx.cloudflare.net; dkim=pass; spf=pass; dmarc=fail",
    }));
    const allFail = scoreSpam(message({
      from: "person@example.net",
      subject: "Hello",
      text: "Just saying hi.",
      authenticationResults: "mx.cloudflare.net; dkim=fail; spf=fail; dmarc=fail",
    }));

    expect(dmarcOnly.reasons).toEqual(["auth_dmarc_fail"]);
    expect(dmarcOnly.verdict).toBe("ham");
    expect(allFail.reasons).toEqual(expect.arrayContaining(["auth_dmarc_fail", "auth_spf_fail", "auth_dkim_fail"]));
    expect(allFail.verdict).toBe("spam");
  });

  it("lets an allow entry skip heuristics and a block entry force spam", () => {
    const allowed = scoreSpam(message({
      from: "Sales <sales@mg.example.com>",
      subject: "We tested your MCP server",
      text: "We tested your MCP server.",
      lists: { ...EMPTY_LISTS, allowSenders: ["sales@mg.example.com"] },
    }));
    const allowedDomain = scoreSpam(message({
      from: "hello@vendor.example.net",
      subject: "Downtime at mcp.customer.example",
      text: "We noticed downtime. Got 15 minutes?",
      lists: { ...EMPTY_LISTS, allowDomains: ["vendor.example.net"] },
    }));
    const blocked = scoreSpam(message({
      from: "researcher@example.org",
      subject: "Who handles security reports?",
      text: "Who handles security reports?",
      lists: { ...EMPTY_LISTS, blockSenders: ["researcher@example.org"] },
    }));
    const blockedParent = scoreSpam(message({
      from: "notice@gmail.com",
      subject: "Hello",
      text: "A normal note.",
      lists: { ...EMPTY_LISTS, blockDomains: ["gmail.com"] },
    }));
    const senderAllowBeatsDomainBlock = scoreSpam(message({
      from: "notice@gmail.com",
      subject: "Important Notice: Email Address Verification",
      text: "",
      lists: {
        ...EMPTY_LISTS,
        allowSenders: ["notice@gmail.com"],
        blockDomains: ["gmail.com"],
      },
    }));

    expect(allowed).toMatchObject({ verdict: "ham", score: 0, reasons: ["allow_sender"] });
    expect(allowedDomain).toMatchObject({ verdict: "ham", score: 0, reasons: ["allow_domain"] });
    expect(blocked).toMatchObject({ verdict: "spam", score: 100, reasons: ["block_sender"] });
    expect(blockedParent).toMatchObject({ verdict: "spam", score: 100, reasons: ["block_domain"] });
    expect(senderAllowBeatsDomainBlock.verdict).toBe("ham");
  });

  it("lets a sender block win when that sender is also allowlisted", () => {
    const both = scoreSpam(message({
      from: "Person <Person@Example.COM>",
      subject: "Hello",
      text: "A normal note.",
      lists: {
        ...EMPTY_LISTS,
        allowSenders: ["person@example.com"],
        blockSenders: ["PERSON@example.com"],
      },
    }));
    const allowOnly = scoreSpam(message({
      from: "Person <Person@Example.COM>",
      subject: "We tested your MCP server",
      text: "We tested your MCP server.",
      lists: { ...EMPTY_LISTS, allowSenders: ["person@example.com"] },
    }));
    expect(both).toMatchObject({ verdict: "spam", score: 100, reasons: ["block_sender"] });
    expect(allowOnly).toMatchObject({ verdict: "ham", score: 0, reasons: ["allow_sender"] });
  });

  it("matches domain rules case-insensitively, including subdomains, and lets an exact sender win", () => {
    const listed = { ...EMPTY_LISTS, blockDomains: ["Example.COM"] };
    expect(scoreSpam(message({
      from: "a@example.com",
      subject: "Hello",
      text: "A normal note.",
      lists: listed,
    }))).toMatchObject({ verdict: "spam", reasons: ["block_domain"] });
    expect(scoreSpam(message({
      from: "a@Sub.Example.com",
      subject: "Hello",
      text: "A normal note.",
      lists: listed,
    }))).toMatchObject({ verdict: "spam", reasons: ["block_domain"] });
    expect(scoreSpam(message({
      from: "a@example.com.evil.test",
      subject: "Hello",
      text: "A normal note.",
      lists: listed,
    })).verdict).toBe("ham");
    expect(scoreSpam(message({
      from: "a@notexample.com",
      subject: "Hello",
      text: "A normal note.",
      lists: listed,
    })).verdict).toBe("ham");
    expect(scoreSpam(message({
      from: "a@sub.example.com",
      subject: "We tested your MCP server",
      text: "We tested your MCP server.",
      lists: {
        ...EMPTY_LISTS,
        blockDomains: ["example.com"],
        allowSenders: ["a@sub.example.com"],
      },
    }))).toMatchObject({ verdict: "ham", reasons: ["allow_sender"] });
    expect(scoreSpam(message({
      from: "a@sub.example.com",
      subject: "Hello",
      text: "A normal note.",
      lists: {
        ...EMPTY_LISTS,
        allowDomains: ["Example.COM"],
        blockSenders: ["a@sub.example.com"],
      },
    }))).toMatchObject({ verdict: "spam", reasons: ["block_sender"] });
  });

  it("treats a score at the threshold as spam and the point below as ham", () => {
    expect(verdictForScore(59, 60)).toBe("ham");
    expect(verdictForScore(60, 60)).toBe("spam");
    expect(verdictForScore(61, 60)).toBe("spam");

    const atThreshold = scoreSpam(message({
      from: "researcher@example.org",
      subject: "Hello",
      text: "A normal note.",
      authenticationResults: "mx.example; dmarc=fail; spf=fail",
      threshold: 60,
    }));
    const below = scoreSpam(message({
      from: "researcher@example.org",
      subject: "Hello",
      text: "A normal note.",
      authenticationResults: "mx.example; dmarc=fail",
      threshold: 60,
    }));
    expect(atThreshold).toMatchObject({ score: 60, verdict: "spam" });
    expect(below).toMatchObject({ score: 40, verdict: "ham" });
  });

  it("scores empty, missing, and malformed headers without throwing", () => {
    const samples = [
      message({ from: "", subject: null, text: "", authenticationResults: null }),
      message({ from: "not-an-email", subject: "", text: "", authenticationResults: "{{{not a header" }),
      message({ from: "person@example.org", subject: null, text: "", authenticationResults: null }),
      message({
        from: "sales@mg.example.com",
        subject: "We tested your MCP server",
        text: "We tested your MCP server.",
        authenticationResults: "garbage authentication results",
      }),
    ];
    for (const sample of samples) {
      const scored = scoreSpam(sample);
      expect(scored.score).toBeGreaterThanOrEqual(0);
      expect(scored.score).toBeLessThanOrEqual(100);
      expect(["spam", "ham"]).toContain(scored.verdict);
      expect(Array.isArray(scored.reasons)).toBe(true);
    }
    expect(scoreSpam(samples[0]!).verdict).toBe("ham");
    expect(scoreSpam(samples[2]!).verdict).toBe("ham");
    expect(scoreSpam(samples[3]!).verdict).toBe("ham");
  });

  it("resolves deployment defaults, then the per-inbox override", () => {
    expect(resolveSpamConfig({})).toEqual({ mode: DEFAULT_SPAM_MODE, threshold: DEFAULT_SPAM_THRESHOLD });
    expect(DEFAULT_SPAM_MODE).toBe("tag");
    expect(resolveSpamConfig({ SPAM_FILTER: "quarantine", SPAM_THRESHOLD: "40" })).toEqual({
      mode: "quarantine",
      threshold: 40,
    });
    expect(resolveSpamConfig({ SPAM_FILTER: "sometimes", SPAM_THRESHOLD: "nope" })).toEqual({
      mode: "tag",
      threshold: DEFAULT_SPAM_THRESHOLD,
    });
    expect(resolveSpamConfig(
      { SPAM_FILTER: "quarantine", SPAM_THRESHOLD: "10" },
      { mode: "tag", threshold: 100 },
    )).toEqual({ mode: "tag", threshold: 100 });
    expect(resolveSpamConfig(
      { SPAM_FILTER: "off", SPAM_THRESHOLD: "80" },
      { mode: null, threshold: null },
    )).toEqual({ mode: "off", threshold: 80 });
    expect(resolveSpamConfig(
      { SPAM_FILTER: "tag", SPAM_THRESHOLD: "60" },
      { mode: "nope", threshold: 101 },
    )).toEqual({ mode: "tag", threshold: 60 });
  });

  it("tags in place, quarantines into the spam folder, and never drops mail when off", () => {
    const spam = scoreSpam(message({
      from: "sales@mg.example.net",
      subject: "We tested your MCP server",
      text: "We noticed a problem. Got 15 minutes?",
    }));
    expect(applySpamFilter("tag", spam, ["billing"])).toEqual({
      folder: "inbox",
      labels: ["billing", "spam"],
    });
    expect(applySpamFilter("quarantine", spam, ["billing"])).toEqual({
      folder: "spam",
      labels: ["billing", "spam"],
    });
    expect(applySpamFilter("off", spam, ["billing"])).toEqual({
      folder: "inbox",
      labels: ["billing"],
    });
    const ham = scoreSpam(message({
      from: "researcher@example.org",
      subject: "Who handles security reports?",
      text: "Who handles security reports?",
    }));
    expect(applySpamFilter("quarantine", ham, [])).toEqual({ folder: "inbox", labels: [] });
  });
});

function message(overrides: Partial<SpamScoreInput> & Pick<SpamScoreInput, "from" | "subject" | "text">): SpamScoreInput {
  return {
    authenticationResults: null,
    recipientDomain: "mail.example.com",
    lists: EMPTY_LISTS,
    threshold: DEFAULT_SPAM_THRESHOLD,
    ...overrides,
  };
}
