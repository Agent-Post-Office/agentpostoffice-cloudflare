import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPAM_THRESHOLD,
  scoreSpam,
  tokenizeMessage,
  signalProbability,
  bayesContribution,
  BAYES_CAP,
  DEFAULT_SPAM_LEARN_MIN,
  type SpamLists,
  type SpamScoreInput,
  type BayesModel,
} from "../src/index.js";
import {
  scoreSpam as apoScoreSpam,
  type SpamScoreInput as ApoInput,
} from "./reference/apo-spam.js";
import {
  tokenizeMessage as apoTokenize,
  signalProbability as apoSignal,
  bayesContribution as apoBayesContribution,
  type BayesModel as ApoModel,
} from "./reference/apo-spam-bayes.js";

const EMPTY_LISTS: SpamLists = {
  allowSenders: [],
  blockSenders: [],
  allowDomains: [],
  blockDomains: [],
};

const PASSING_AUTH =
  "mx.cloudflare.net; dkim=pass header.d=example.test header.s=s1; spf=pass smtp.mailfrom=bounce@example.test; dmarc=pass header.from=example.test";

type Fixture = Partial<SpamScoreInput> & Pick<SpamScoreInput, "from" | "subject" | "text">;

const FIXTURES: Fixture[] = [
  {
    from: "sales@mg.example.com",
    subject: "We tested your MCP server",
    text: "We tested your MCP server and wanted to share what we found.",
    authenticationResults: PASSING_AUTH.replaceAll("example.test", "mg.example.com"),
  },
  {
    from: "hello@vendor.example.net",
    subject: "Downtime at mcp.customer.example",
    text: "We noticed downtime at mcp.customer.example. Got 15 minutes to walk through it?",
    authenticationResults: PASSING_AUTH.replaceAll("example.test", "vendor.example.net"),
  },
  {
    from: "notice@gmail.com",
    subject: "Important Notice: Email Address Verification",
    text: "",
    authenticationResults: PASSING_AUTH.replaceAll("example.test", "gmail.com"),
  },
  {
    from: "researcher@example.org",
    subject: "Who handles security reports?",
    text: "Hello, I found a problem in the public MCP endpoint and need to know who handles security reports before I send the write-up.",
    authenticationResults: PASSING_AUTH.replaceAll("example.test", "example.org"),
  },
  {
    from: "sales@mg.example.net",
    subject: "We tested your MCP server",
    text: "We noticed a problem. Got 15 minutes?",
    authenticationResults: null,
  },
  {
    from: "sales@mg.example.com",
    subject: "We tested your MCP server",
    text: "We tested your MCP server and wanted to share what we found.",
    authenticationResults: null,
  },
  {
    from: "person@example.net",
    subject: "Hello",
    text: "Just saying hi.",
    authenticationResults: "mx.cloudflare.net; dkim=pass; spf=pass; dmarc=fail",
  },
  {
    from: "person@example.net",
    subject: "Hello",
    text: "Just saying hi.",
    authenticationResults: "mx.cloudflare.net; dkim=fail; spf=fail; dmarc=fail",
  },
  {
    from: "Sales <sales@mg.example.com>",
    subject: "We tested your MCP server",
    text: "We tested your MCP server.",
    lists: { ...EMPTY_LISTS, allowSenders: ["sales@mg.example.com"] },
  },
  {
    from: "hello@vendor.example.net",
    subject: "Downtime at mcp.customer.example",
    text: "We noticed downtime. Got 15 minutes?",
    lists: { ...EMPTY_LISTS, allowDomains: ["vendor.example.net"] },
  },
  {
    from: "researcher@example.org",
    subject: "Who handles security reports?",
    text: "Who handles security reports?",
    lists: { ...EMPTY_LISTS, blockSenders: ["researcher@example.org"] },
  },
  {
    from: "notice@gmail.com",
    subject: "Hello",
    text: "A normal note.",
    lists: { ...EMPTY_LISTS, blockDomains: ["gmail.com"] },
  },
  {
    from: "notice@gmail.com",
    subject: "Important Notice: Email Address Verification",
    text: "",
    lists: {
      ...EMPTY_LISTS,
      allowSenders: ["notice@gmail.com"],
      blockDomains: ["gmail.com"],
    },
  },
  {
    from: "Person <Person@Example.COM>",
    subject: "Hello",
    text: "A normal note.",
    lists: {
      ...EMPTY_LISTS,
      allowSenders: ["person@example.com"],
      blockSenders: ["PERSON@example.com"],
    },
  },
  {
    from: "a@example.com",
    subject: "Hello",
    text: "Hi",
    lists: { ...EMPTY_LISTS, allowDomains: ["example.com"] },
  },
  {
    from: "a@Sub.Example.com",
    subject: "Hello",
    text: "Hi",
    lists: { ...EMPTY_LISTS, allowDomains: ["example.com"] },
  },
  {
    from: "a@example.com.evil.test",
    subject: "Hello",
    text: "Hi",
    lists: { ...EMPTY_LISTS, allowDomains: ["example.com"] },
  },
  {
    from: "a@notexample.com",
    subject: "Hello",
    text: "Hi",
    lists: { ...EMPTY_LISTS, allowDomains: ["example.com"] },
  },
  {
    from: "a@sub.example.com",
    subject: "Hello",
    text: "Hi",
    lists: {
      ...EMPTY_LISTS,
      allowDomains: ["example.com"],
      allowSenders: ["a@sub.example.com"],
    },
  },
  {
    from: "a@sub.example.com",
    subject: "Hello",
    text: "Hi",
    lists: {
      ...EMPTY_LISTS,
      blockDomains: ["example.com"],
      blockSenders: ["a@sub.example.com"],
    },
  },
  {
    from: "researcher@example.org",
    subject: "Hello",
    text: "A normal note.",
    authenticationResults: "mx; dkim=fail; spf=softfail; dmarc=fail",
  },
  {
    from: "researcher@example.org",
    subject: null,
    text: "",
    authenticationResults: null,
  },
  {
    from: "person@example.org",
    subject: null,
    text: "",
    authenticationResults: null,
  },
  {
    from: "sales@mg.example.com",
    subject: "We tested your MCP server",
    text: "We tested your MCP server.",
    authenticationResults: PASSING_AUTH.replaceAll("example.test", "mg.example.com"),
    threshold: 100,
  },
  {
    from: "friend@example.com",
    subject: "Lunch tomorrow?",
    text: "Want to grab lunch tomorrow around noon?",
    authenticationResults: PASSING_AUTH,
  },
  {
    from: "Seller <seller@gmail.com>",
    subject: "We tested your site — Important notice: verify your email address — downtime at other.example.org",
    text: "We noticed your product. Got 15 minutes for a quick call? Book a demo this week.",
    authenticationResults: "mx.cloudflare.com; dkim=pass; spf=pass; dmarc=pass",
  },
];

function message(overrides: Fixture): SpamScoreInput {
  return {
    authenticationResults: null,
    recipientDomain: "mail.example.com",
    lists: EMPTY_LISTS,
    threshold: DEFAULT_SPAM_THRESHOLD,
    ...overrides,
  };
}

const SPAM_FROM = "Person <person@spammy.test>";
const HAM_FROM = "Person <person@weekly.test>";
const SPAM_SUBJECT = "prizewinner wiretransfer limitedoffer";
const HAM_SUBJECT = "weeklystatus standupnotes shipnotes";

function trained(spamMessages: number, hamMessages: number): BayesModel {
  const tokens = new Map<string, { spam: number; ham: number }>();
  const add = (label: "spam" | "ham", count: number, subject: string, from: string) => {
    for (const token of tokenizeMessage({ subject, text: "A short note.", from })) {
      const row = tokens.get(token) ?? { spam: 0, ham: 0 };
      row[label] += count;
      tokens.set(token, row);
    }
  };
  add("spam", spamMessages, SPAM_SUBJECT, SPAM_FROM);
  add("ham", hamMessages, HAM_SUBJECT, HAM_FROM);
  return { spamMessages, hamMessages, tokens };
}

describe("parity with APO 8ccceaf", () => {
  it("matches score, reasons, and verdict on every fixture (26 cases)", () => {
    expect(FIXTURES.length).toBe(26);
    const diffs: string[] = [];
    for (const [index, fixture] of FIXTURES.entries()) {
      const input = message(fixture);
      const pkg = scoreSpam(input);
      const apo = apoScoreSpam(input as ApoInput);
      if (JSON.stringify(pkg) !== JSON.stringify(apo)) {
        diffs.push(`#${index} pkg=${JSON.stringify(pkg)} apo=${JSON.stringify(apo)}`);
      }
    }
    expect(diffs, diffs.join("\n")).toEqual([]);
  });

  it("matches Bayes tokenize, posterior, contribution, and scoreSpam with bayes", () => {
    const diffs: string[] = [];
    const model = trained(DEFAULT_SPAM_LEARN_MIN, DEFAULT_SPAM_LEARN_MIN) as ApoModel;
    const input = { subject: SPAM_SUBJECT, text: "Please review this note.", from: SPAM_FROM };
    const pkgTokens = tokenizeMessage(input);
    const apoTokens = apoTokenize(input);
    if (JSON.stringify(pkgTokens) !== JSON.stringify(apoTokens)) {
      diffs.push(`tokens pkg=${JSON.stringify(pkgTokens)} apo=${JSON.stringify(apoTokens)}`);
    }
    const pkgP = signalProbability(model as BayesModel, pkgTokens, DEFAULT_SPAM_LEARN_MIN);
    const apoP = apoSignal(model, apoTokens, DEFAULT_SPAM_LEARN_MIN);
    if (pkgP !== apoP) diffs.push(`probability pkg=${pkgP} apo=${apoP}`);
    const pkgC = bayesContribution(pkgP);
    const apoC = apoBayesContribution(apoP);
    if (JSON.stringify(pkgC) !== JSON.stringify(apoC)) {
      diffs.push(`contribution pkg=${JSON.stringify(pkgC)} apo=${JSON.stringify(apoC)}`);
    }
    const scoredInput = message({
      from: SPAM_FROM,
      subject: SPAM_SUBJECT,
      text: "Please review this note.",
      bayes: { spamProbability: pkgP },
    });
    const pkgScore = scoreSpam(scoredInput);
    const apoScore = apoScoreSpam(scoredInput as ApoInput);
    if (JSON.stringify(pkgScore) !== JSON.stringify(apoScore)) {
      diffs.push(`scored pkg=${JSON.stringify(pkgScore)} apo=${JSON.stringify(apoScore)}`);
    }
    expect(pkgScore.score).toBe(BAYES_CAP);
    expect(diffs, diffs.join("\n")).toEqual([]);
  });

  it("matches under-min and null bayes gates", () => {
    const diffs: string[] = [];
    const model = trained(DEFAULT_SPAM_LEARN_MIN - 1, DEFAULT_SPAM_LEARN_MIN - 1);
    const tokens = tokenizeMessage({ subject: SPAM_SUBJECT, text: "x", from: SPAM_FROM });
    const pkg = signalProbability(model, tokens, DEFAULT_SPAM_LEARN_MIN);
    const apo = apoSignal(model as ApoModel, tokens, DEFAULT_SPAM_LEARN_MIN);
    if (pkg !== apo) diffs.push(`under-min pkg=${pkg} apo=${apo}`);
    for (const bayes of [undefined, null, { spamProbability: null }] as const) {
      const input = message({
        from: SPAM_FROM,
        subject: SPAM_SUBJECT,
        text: "Please review this note.",
        ...(bayes === undefined ? {} : { bayes }),
      });
      const pkgScore = scoreSpam(input);
      const apoScore = apoScoreSpam(input as ApoInput);
      if (JSON.stringify(pkgScore) !== JSON.stringify(apoScore)) {
        diffs.push(`bayes=${JSON.stringify(bayes)} pkg=${JSON.stringify(pkgScore)} apo=${JSON.stringify(apoScore)}`);
      }
    }
    expect(diffs, diffs.join("\n")).toEqual([]);
  });
});
