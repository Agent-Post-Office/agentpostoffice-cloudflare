import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  AUTH_FAILURE_WEIGHTS,
  CONTENT_RULE_WEIGHTS,
  DEFAULT_SPAM_THRESHOLD,
  scoreSpam,
  type SpamLists,
  type SpamScoreInput,
} from "../src/index.js";
import {
  BAYES_CAP,
  BAYES_SPAM_FLOOR,
  DEFAULT_SPAM_LEARN_MIN,
  MAX_BODY_CHARS,
  MAX_TOKENS,
  bayesContribution,
  classify,
  signalProbability,
  spamLearnEnabled,
  spamLearnMin,
  tokenizeMessage,
  trainingDelta,
  type BayesModel,
  type TrainingState,
} from "../src/index.js";

const EMPTY_LISTS: SpamLists = {
  allowSenders: [],
  blockSenders: [],
  allowDomains: [],
  blockDomains: [],
};

const SPAM_FROM = "Person <person@spammy.test>";
const HAM_FROM = "Person <person@weekly.test>";
const SPAM_SUBJECT = "prizewinner wiretransfer limitedoffer";
const HAM_SUBJECT = "weeklystatus standupnotes shipnotes";

describe("spam bayes tokenizer", () => {
  it("tokenizes subject, decoded text, the sender domain, and URL hosts", () => {
    const tokens = tokenizeMessage({
      subject: "Account notice",
      text: "Visit https://Track.Example.TEST/path?q=1. and http://other.example.test/x",
      from: "Person <Person@Example.TEST>",
    });
    expect(tokens[0]).toBe("domain:example.test");
    expect(tokens).toContain("host:track.example.test");
    expect(tokens).toContain("host:other.example.test");
    expect(tokens).toContain("account");
    expect(tokens).toContain("notice");
    expect(tokens).toContain("visit");
    expect(tokens).not.toContain("https");
  });

  it("bounds tokens per message and ignores text past the scan window", () => {
    const sentinel = "zzzendtoken";
    const filler = `${"alpha ".repeat(2_000)}${sentinel}`;
    expect(filler.length).toBeGreaterThan(MAX_BODY_CHARS);
    const tokens = tokenizeMessage({ subject: "Hello there", text: filler, from: "a@example.test" });
    expect(tokens).not.toContain(sentinel);
    expect(tokens.length).toBeLessThanOrEqual(MAX_TOKENS);
    expect(tokens.every((token) => token.length <= 80)).toBe(true);

    const many = Array.from({ length: 400 }, (_, index) => `tok${index}xx`).join(" ");
    const capped = tokenizeMessage({ subject: many, text: many, from: "a@example.test" });
    expect(capped).toHaveLength(MAX_TOKENS);
    expect(capped[0]).toBe("domain:example.test");
  });

  it("stays in pure TypeScript without Node built-ins", () => {
    const source = readFileSync("src/bayes.ts", "utf8");
    expect(source).not.toMatch(/from ["']node:/);
    expect(source).not.toMatch(/from ["'](?:fs|path|url|crypto|buffer)["']/);
    expect(source).not.toMatch(/\brequire\(/);
  });
});

describe("spam bayes signal", () => {
  it("contributes nothing below N marks in either class", () => {
    const model = trained(DEFAULT_SPAM_LEARN_MIN - 1, DEFAULT_SPAM_LEARN_MIN - 1);
    expect(signalProbability(model, spamTokens(), DEFAULT_SPAM_LEARN_MIN)).toBeNull();
    expect(signalProbability(trained(DEFAULT_SPAM_LEARN_MIN, DEFAULT_SPAM_LEARN_MIN - 1), spamTokens(), DEFAULT_SPAM_LEARN_MIN)).toBeNull();
    expect(signalProbability(trained(0, 0), spamTokens(), DEFAULT_SPAM_LEARN_MIN)).toBeNull();
    const scored = scoreSpam(neutralSpammy({ bayes: { spamProbability: null } }));
    expect(JSON.stringify(scored)).toBe(JSON.stringify(scoreSpam(neutralSpammy())));
    expect(scored.reasons.some((reason) => reason.startsWith("bayes_"))).toBe(false);
  });

  it("learns a spam posterior after N marks in each class and records bayes_spam_p", () => {
    const model = trained(DEFAULT_SPAM_LEARN_MIN, DEFAULT_SPAM_LEARN_MIN);
    const probability = signalProbability(model, spamTokens(), DEFAULT_SPAM_LEARN_MIN);
    expect(probability).not.toBeNull();
    const contribution = bayesContribution(probability);
    expect(contribution.points).toBe(BAYES_CAP);
    expect(contribution.reason).toMatch(/^bayes_spam_(?:0\.\d{2}|1\.00)$/);
    const scored = scoreSpam(neutralSpammy({ bayes: { spamProbability: probability } }));
    expect(scored.score).toBe(BAYES_CAP);
    expect(scored.reasons).toEqual([contribution.reason]);
    expect(scored.verdict).toBe("ham");
    expect(scored.score).toBeLessThan(DEFAULT_SPAM_THRESHOLD);

    const withAuth = scoreSpam(neutralSpammy({
      authenticationResults: "mx.example.test; dkim=pass; spf=pass; dmarc=fail",
      bayes: { spamProbability: probability },
    }));
    expect(withAuth.score).toBe(BAYES_CAP + AUTH_FAILURE_WEIGHTS.auth_dmarc_fail);
    expect(withAuth.verdict).toBe("spam");
    expect(withAuth.reasons).toEqual(["auth_dmarc_fail", contribution.reason]);
  });

  it("caps Bayes under the threshold alone and lets every other signal reach it", () => {
    const independent = [
      ...Object.entries(CONTENT_RULE_WEIGHTS),
      ...Object.entries(AUTH_FAILURE_WEIGHTS),
    ];
    expect(independent.length).toBeGreaterThan(0);
    const smallest = Math.min(...independent.map(([, weight]) => weight));
    expect(smallest).toBe(8);
    expect(BAYES_CAP).toBe(DEFAULT_SPAM_THRESHOLD - smallest);
    expect(BAYES_CAP).toBeLessThan(DEFAULT_SPAM_THRESHOLD);
    expect(BAYES_CAP).toBeGreaterThan(0);
    for (const [name, weight] of independent) {
      expect(weight, name).toBeGreaterThan(0);
      expect(BAYES_CAP, `${name} is not part of the Bayes cap`).toBeLessThan(DEFAULT_SPAM_THRESHOLD);
      expect(BAYES_CAP + weight, `bayes + ${name}`).toBeGreaterThanOrEqual(DEFAULT_SPAM_THRESHOLD);
    }
    for (let step = 0; step <= 100; step += 1) {
      const contribution = bayesContribution(step / 100);
      expect(contribution.points).toBeGreaterThanOrEqual(0);
      expect(contribution.points).toBeLessThanOrEqual(BAYES_CAP);
      expect(contribution.points).toBeLessThan(DEFAULT_SPAM_THRESHOLD);
      if (contribution.points === 0) expect(contribution.reason).toBeNull();
      else expect(contribution.reason).toMatch(/^bayes_spam_(?:0\.\d{2}|1\.00)$/);
    }
    expect(bayesContribution(0.97)).toEqual({
      points: Math.round(BAYES_CAP * ((0.97 - BAYES_SPAM_FLOOR) / (1 - BAYES_SPAM_FLOOR))),
      reason: "bayes_spam_0.97",
    });
    expect(bayesContribution(0.5)).toEqual({ points: 0, reason: null });
    expect(bayesContribution(Number.NaN)).toEqual({ points: 0, reason: null });
  });

  it("does not let an allow or block decision get a Bayes adjustment", () => {
    const allowed = scoreSpam(neutralSpammy({
      lists: { ...EMPTY_LISTS, allowSenders: ["person@spammy.test"] },
      bayes: { spamProbability: 1 },
    }));
    const blocked = scoreSpam(message({
      from: "researcher@example.org",
      subject: "Hello",
      text: "A normal note.",
      lists: { ...EMPTY_LISTS, blockSenders: ["researcher@example.org"] },
      bayes: { spamProbability: 0 },
    }));
    expect(allowed).toEqual({ score: 0, reasons: ["allow_sender"], verdict: "ham" });
    expect(blocked).toEqual({ score: 100, reasons: ["block_sender"], verdict: "spam" });
  });

  it("keeps the rules score when the classifier fails", () => {
    expect(() => classify(spamTokens(), { spamMessages: -1, hamMessages: 20, tokens: new Map() })).toThrow();
    const rules = scoreSpam(neutralSpammy());
    let scored = rules;
    try {
      const probability = classify(spamTokens(), { spamMessages: -1, hamMessages: 20, tokens: new Map() });
      scored = scoreSpam(neutralSpammy({ bayes: { spamProbability: probability } }));
    } catch {
      scored = rules;
    }
    expect(JSON.stringify(scored)).toBe(JSON.stringify(rules));
    expect(JSON.stringify(scoreSpam(neutralSpammy({ bayes: { spamProbability: Number.NaN } })))).toBe(JSON.stringify(rules));
  });

  it("is off unless SPAM_LEARN is on, and an absent signal matches the rules JSON", () => {
    expect(DEFAULT_SPAM_LEARN_MIN).toBe(20);
    expect(spamLearnEnabled({})).toBe(false);
    expect(spamLearnEnabled({ SPAM_LEARN: "" })).toBe(false);
    expect(spamLearnEnabled({ SPAM_LEARN: "off" })).toBe(false);
    expect(spamLearnEnabled({ SPAM_LEARN: "0" })).toBe(false);
    expect(spamLearnEnabled({ SPAM_LEARN: "false" })).toBe(false);
    expect(spamLearnEnabled({ SPAM_LEARN: "on" })).toBe(true);
    expect(spamLearnEnabled({ SPAM_LEARN: "TRUE" })).toBe(true);
    expect(spamLearnEnabled({ SPAM_LEARN: "1" })).toBe(true);
    expect(spamLearnMin({})).toBe(20);
    expect(spamLearnMin({ SPAM_LEARN_MIN: "2" })).toBe(2);
    expect(spamLearnMin({ SPAM_LEARN_MIN: "0" })).toBe(20);
    expect(spamLearnMin({ SPAM_LEARN_MIN: "nope" })).toBe(20);
    expect(spamLearnMin({ SPAM_LEARN_MIN: "20" })).toBe(20);

    const samples = [
      neutralSpammy(),
      message({
        from: "sales@mg.example.com",
        subject: "We tested your MCP server",
        text: "We tested your MCP server and wanted to share what we found.",
        authenticationResults: "mx.cloudflare.net; dkim=pass; spf=pass; dmarc=pass",
      }),
      message({
        from: "researcher@example.org",
        subject: "Who handles security reports?",
        text: "Who handles security reports?",
      }),
    ];
    for (const sample of samples) {
      const rules = JSON.stringify(scoreSpam(sample));
      expect(JSON.stringify(scoreSpam({ ...sample, bayes: undefined }))).toBe(rules);
      expect(JSON.stringify(scoreSpam({ ...sample, bayes: null }))).toBe(rules);
      expect(JSON.stringify(scoreSpam({ ...sample, bayes: { spamProbability: null } }))).toBe(rules);
    }
  });

  it("adjusts counts once on a repeated mark and moves them on a flip", () => {
    const next = state("spam", spamTokens());
    const first = trainingDelta(null, next);
    expect(first.noop).toBe(false);
    expect(first.spamMessages).toBe(1);
    expect(first.hamMessages).toBe(0);
    const again = trainingDelta(next, next);
    expect(again).toEqual({ tokens: [], spamMessages: 0, hamMessages: 0, noop: true });
    const flipped = trainingDelta(next, state("ham", spamTokens()));
    expect(flipped.noop).toBe(false);
    expect(flipped.spamMessages).toBe(-1);
    expect(flipped.hamMessages).toBe(1);
    for (const token of first.tokens) {
      const moved = flipped.tokens.find((row) => row.token === token.token);
      expect(moved).toEqual({ token: token.token, spam: -1, ham: 1 });
    }
    const counts = new Map<string, { spam: number; ham: number }>();
    let spamMessages = 0;
    let hamMessages = 0;
    const apply = (delta: ReturnType<typeof trainingDelta>) => {
      spamMessages += delta.spamMessages;
      hamMessages += delta.hamMessages;
      for (const row of delta.tokens) {
        const current = counts.get(row.token) ?? { spam: 0, ham: 0 };
        current.spam += row.spam;
        current.ham += row.ham;
        counts.set(row.token, current);
      }
    };
    apply(first);
    apply(again);
    expect(spamMessages).toBe(1);
    expect(hamMessages).toBe(0);
    for (const row of counts.values()) expect(row).toEqual({ spam: 1, ham: 0 });
    apply(flipped);
    apply(trainingDelta(state("ham", spamTokens()), state("ham", spamTokens())));
    expect(spamMessages).toBe(0);
    expect(hamMessages).toBe(1);
    for (const row of counts.values()) {
      expect(row).toEqual({ spam: 0, ham: 1 });
      expect(row.spam).toBeGreaterThanOrEqual(0);
      expect(row.ham).toBeGreaterThanOrEqual(0);
    }
    apply(trainingDelta(state("ham", spamTokens()), next));
    expect(spamMessages).toBe(1);
    expect(hamMessages).toBe(0);
  });

  it("classifies a bounded message in a small CPU budget", () => {
    const model = trained(DEFAULT_SPAM_LEARN_MIN, DEFAULT_SPAM_LEARN_MIN);
    const text = Array.from({ length: 800 }, (_, index) => `w${index.toString(36)}xx`).join(" ");
    const input = {
      subject: SPAM_SUBJECT,
      text,
      from: SPAM_FROM,
    };
    const iterations = 200;
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      const tokens = tokenizeMessage(input);
      const probability = signalProbability(model, tokens, DEFAULT_SPAM_LEARN_MIN);
      bayesContribution(probability);
    }
    const perMessage = (performance.now() - started) / iterations;
    console.log(`bayes_cpu_ms=${perMessage.toFixed(4)}`);
    expect(perMessage, `bayes_cpu_ms=${perMessage.toFixed(4)}`).toBeLessThan(5);
  });
});

function spamTokens(): string[] {
  return tokenizeMessage({ subject: SPAM_SUBJECT, text: "Please review this note.", from: SPAM_FROM });
}

function state(label: "spam" | "ham", tokens: string[]): TrainingState {
  return { label, tokens };
}

function trained(spamMessages: number, hamMessages: number): BayesModel {
  const tokens = new Map<string, { spam: number; ham: number }>();
  const add = (label: "spam" | "ham", count: number, subject: string, from: string) => {
    const seen = tokenizeMessage({ subject, text: "A short note.", from });
    for (const token of seen) {
      const row = tokens.get(token) ?? { spam: 0, ham: 0 };
      row[label] += count;
      tokens.set(token, row);
    }
  };
  add("spam", spamMessages, SPAM_SUBJECT, SPAM_FROM);
  add("ham", hamMessages, HAM_SUBJECT, HAM_FROM);
  return { spamMessages, hamMessages, tokens };
}

function neutralSpammy(overrides: Partial<SpamScoreInput> = {}): SpamScoreInput {
  return message({
    from: SPAM_FROM,
    subject: SPAM_SUBJECT,
    text: "Please review this note.",
    ...overrides,
  });
}

function message(overrides: Partial<SpamScoreInput> & Pick<SpamScoreInput, "from" | "subject" | "text">): SpamScoreInput {
  return {
    authenticationResults: null,
    recipientDomain: "mail.example.com",
    lists: EMPTY_LISTS,
    threshold: DEFAULT_SPAM_THRESHOLD,
    ...overrides,
  };
}
