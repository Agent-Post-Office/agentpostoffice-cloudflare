import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPAM_MODE,
  DEFAULT_SPAM_THRESHOLD,
  applySpamFilter,
  resolveSpamConfig,
  scoreSpam,
  type SpamLists,
  type SpamScoreInput,
} from "../packages/worker/src/spam.js";

const EMPTY_LISTS: SpamLists = {
  allowSenders: [],
  blockSenders: [],
  allowDomains: [],
  blockDomains: [],
};

const PASSING_AUTH = "mx.cloudflare.net; dkim=pass header.d=example.test header.s=s1; spf=pass smtp.mailfrom=bounce@example.test; dmarc=pass header.from=example.test";

describe("spam rules scorer", () => {
  it("flags the reported cold audit, incident pitch, and verification lure, and leaves a security report alone", () => {
    const sealkeeper = scoreSpam(message({
      from: "sales@mg.sealkeeper.run",
      subject: "We tested your MCP server",
      text: "We tested your MCP server and wanted to share what we found.",
      authenticationResults: PASSING_AUTH.replaceAll("example.test", "mg.sealkeeper.run"),
    }));
    const fixter = scoreSpam(message({
      from: "hello@getfixter.com",
      subject: "Downtime at mcp.agentanalytics.sh",
      text: "We noticed downtime at mcp.agentanalytics.sh. Got 15 minutes to walk through it?",
      authenticationResults: PASSING_AUTH.replaceAll("example.test", "getfixter.com"),
    }));
    const yandex = scoreSpam(message({
      from: "tech.carrot@yandex.ru",
      subject: "Important Notice: Email Address Verification",
      text: "",
      authenticationResults: PASSING_AUTH.replaceAll("example.test", "yandex.ru"),
    }));
    const securityReport = scoreSpam(message({
      from: "researcher@example.org",
      subject: "Who handles security reports?",
      text: "Hello, I found a problem in the public MCP endpoint and need to know who handles security reports before I send the write-up.",
      authenticationResults: PASSING_AUTH.replaceAll("example.test", "example.org"),
    }));

    for (const result of [sealkeeper, fixter, yandex]) {
      expect(result.verdict).toBe("spam");
      expect(result.score).toBeGreaterThanOrEqual(DEFAULT_SPAM_THRESHOLD);
      expect(result.reasons.some((reason) => reason.startsWith("auth_"))).toBe(false);
    }
    expect(sealkeeper.reasons).toEqual(expect.arrayContaining(["cold_audit", "marketing_subdomain"]));
    expect(fixter.reasons).toEqual(expect.arrayContaining(["outreach_opener", "meeting_ask", "unrelated_incident"]));
    expect(yandex.reasons).toEqual(expect.arrayContaining(["verification_subject", "freemail_verification", "empty_verification_body"]));

    expect(securityReport.verdict).toBe("ham");
    expect(securityReport.score).toBeLessThan(DEFAULT_SPAM_THRESHOLD);
    expect(securityReport.reasons).toEqual([]);
  });

  it("does not let a passing Authentication-Results header decide the verdict", () => {
    const withoutAuth = scoreSpam(message({
      from: "sales@mg.sealkeeper.run",
      subject: "We tested your MCP server",
      text: "We tested your MCP server and wanted to share what we found.",
      authenticationResults: null,
    }));
    const withAuth = scoreSpam(message({
      from: "sales@mg.sealkeeper.run",
      subject: "We tested your MCP server",
      text: "We tested your MCP server and wanted to share what we found.",
      authenticationResults: PASSING_AUTH.replaceAll("example.test", "mg.sealkeeper.run"),
    }));
    const ham = scoreSpam(message({
      from: "researcher@example.org",
      subject: "Who handles security reports?",
      text: "Who handles security reports for this mailbox?",
      authenticationResults: PASSING_AUTH,
    }));

    expect(withAuth).toEqual(withoutAuth);
    expect(withAuth.verdict).toBe("spam");
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
      from: "Sales <sales@mg.sealkeeper.run>",
      subject: "We tested your MCP server",
      text: "We tested your MCP server.",
      lists: { ...EMPTY_LISTS, allowSenders: ["sales@mg.sealkeeper.run"] },
    }));
    const allowedDomain = scoreSpam(message({
      from: "hello@getfixter.com",
      subject: "Downtime at mcp.agentanalytics.sh",
      text: "We noticed downtime. Got 15 minutes?",
      lists: { ...EMPTY_LISTS, allowDomains: ["getfixter.com"] },
    }));
    const blocked = scoreSpam(message({
      from: "researcher@example.org",
      subject: "Who handles security reports?",
      text: "Who handles security reports?",
      lists: { ...EMPTY_LISTS, blockSenders: ["researcher@example.org"] },
    }));
    const blockedParent = scoreSpam(message({
      from: "tech.carrot@yandex.ru",
      subject: "Hello",
      text: "A normal note.",
      lists: { ...EMPTY_LISTS, blockDomains: ["yandex.ru"] },
    }));
    const senderAllowBeatsDomainBlock = scoreSpam(message({
      from: "tech.carrot@yandex.ru",
      subject: "Important Notice: Email Address Verification",
      text: "",
      lists: {
        ...EMPTY_LISTS,
        allowSenders: ["tech.carrot@yandex.ru"],
        blockDomains: ["yandex.ru"],
      },
    }));

    expect(allowed).toMatchObject({ verdict: "ham", score: 0, reasons: ["allow_sender"] });
    expect(allowedDomain).toMatchObject({ verdict: "ham", score: 0, reasons: ["allow_domain"] });
    expect(blocked).toMatchObject({ verdict: "spam", score: 100, reasons: ["block_sender"] });
    expect(blockedParent).toMatchObject({ verdict: "spam", score: 100, reasons: ["block_domain"] });
    expect(senderAllowBeatsDomainBlock.verdict).toBe("ham");
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
      from: "sales@mg.sealkeeper.run",
      subject: "We tested your MCP server",
      text: "We tested your MCP server.",
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
