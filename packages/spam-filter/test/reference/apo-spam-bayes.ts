/** Verbatim APO 8ccceaf spam-bayes.ts for parity tests. */
import { normalizeAddress, normalizeDomain } from "./util.js";

// Bayes is one weighted signal on the 0-100 score.
//
// BAYES_CAP is 52. That is the default threshold (60) minus the smallest other
// positive weight (8, urgency_notice and freemail_verification). A confident
// posterior therefore stays ham by itself: 52 is under 60. Adding any one
// other content or authentication signal reaches 60, so Bayes plus one
// independent signal may flag the message. Ham posteriors add no points, so
// learning cannot hide a rules hit.
//
// The points scale only after the posterior reaches 0.90:
//   round(52 * (p - 0.90) / 0.10)
// p = 0.97 is bayes_spam_0.97 and 36 points. p = 1.00 is the full 52.
// Below 0.90, or before the inbox has N marks in each class, the signal is
// omitted. N defaults to 20 (SPAM_LEARN_MIN).
export const BAYES_CAP = 52;
export const BAYES_SPAM_FLOOR = 0.9;
export const DEFAULT_SPAM_LEARN_MIN = 20;

export const MAX_SUBJECT_CHARS = 500;
export const MAX_BODY_CHARS = 4_000;
export const MAX_TOKENS = 64;
export const MAX_URLS = 16;
export const MAX_WORD_LENGTH = 32;
export const MAX_FEATURE_LENGTH = 80;
export const MAX_CLASSIFIER_TOKENS = 15;

const MIN_WORD_LENGTH = 3;
const TOKEN_CLAMP = 0.01;

const WORD_PATTERN = /[a-z0-9]{3,32}/g;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

export interface BayesSignal {
  spamProbability: number | null;
}

export interface BayesModel {
  spamMessages: number;
  hamMessages: number;
  tokens: ReadonlyMap<string, { spam: number; ham: number }>;
}

export interface TrainingState {
  label: "spam" | "ham";
  tokens: readonly string[];
}

export interface TokenCountDelta {
  token: string;
  spam: number;
  ham: number;
}

export interface TrainingDelta {
  tokens: TokenCountDelta[];
  spamMessages: number;
  hamMessages: number;
  noop: boolean;
}

export function spamLearnEnabled(env: { SPAM_LEARN?: string }): boolean {
  if (typeof env.SPAM_LEARN !== "string") return false;
  const value = env.SPAM_LEARN.trim().toLowerCase();
  return value === "on" || value === "true" || value === "1";
}

export function spamLearnMin(env: { SPAM_LEARN_MIN?: string }): number {
  if (typeof env.SPAM_LEARN_MIN !== "string" || env.SPAM_LEARN_MIN.trim() === "") return DEFAULT_SPAM_LEARN_MIN;
  const parsed = Number(env.SPAM_LEARN_MIN);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100_000) return DEFAULT_SPAM_LEARN_MIN;
  return parsed;
}

export function bayesContribution(probability: number | null | undefined): { points: number; reason: string | null } {
  if (typeof probability !== "number" || !Number.isFinite(probability)) return { points: 0, reason: null };
  const clamped = Math.min(1, Math.max(0, probability));
  if (clamped < BAYES_SPAM_FLOOR) return { points: 0, reason: null };
  const strength = (clamped - BAYES_SPAM_FLOOR) / (1 - BAYES_SPAM_FLOOR);
  const points = Math.min(BAYES_CAP, Math.round(BAYES_CAP * strength));
  if (points <= 0) return { points: 0, reason: null };
  const shown = (Math.round(clamped * 100) / 100).toFixed(2);
  return { points, reason: `bayes_spam_${shown}` };
}

export function tokenizeMessage(input: { subject: string | null; text: string; from: string }): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const push = (token: string) => {
    if (tokens.length >= MAX_TOKENS || token.length === 0 || token.length > MAX_FEATURE_LENGTH || seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };

  const domain = senderDomain(input.from);
  if (domain) push(`domain:${domain}`);

  const subject = (input.subject ?? "").slice(0, MAX_SUBJECT_CHARS);
  const text = (input.text ?? "").slice(0, MAX_BODY_CHARS);
  for (const host of urlHosts(`${subject}\n${text}`)) push(`host:${host}`);
  for (const word of words(subject)) push(word);
  for (const word of words(text)) push(word);
  return tokens;
}

export function canonicalTokens(tokens: readonly string[]): string[] {
  return [...new Set(tokens)].sort();
}

export function trainingDelta(previous: TrainingState | null, next: TrainingState): TrainingDelta {
  const nextTokens = canonicalTokens(next.tokens);
  const previousTokens = previous ? canonicalTokens(previous.tokens) : null;
  if (
    previous
    && previousTokens
    && previous.label === next.label
    && previousTokens.length === nextTokens.length
    && previousTokens.every((token, index) => token === nextTokens[index])
  ) {
    return { tokens: [], spamMessages: 0, hamMessages: 0, noop: true };
  }

  const map = new Map<string, { spam: number; ham: number }>();
  const add = (token: string, label: "spam" | "ham", amount: number) => {
    const row = map.get(token) ?? { spam: 0, ham: 0 };
    row[label] += amount;
    if (row.spam === 0 && row.ham === 0) map.delete(token);
    else map.set(token, row);
  };
  if (previous && previousTokens) {
    for (const token of previousTokens) add(token, previous.label, -1);
  }
  for (const token of nextTokens) add(token, next.label, 1);

  return {
    tokens: [...map.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([token, row]) => ({ token, spam: row.spam, ham: row.ham })),
    spamMessages: (next.label === "spam" ? 1 : 0) - (previous?.label === "spam" ? 1 : 0),
    hamMessages: (next.label === "ham" ? 1 : 0) - (previous?.label === "ham" ? 1 : 0),
    noop: false,
  };
}

export function signalProbability(model: BayesModel, tokens: readonly string[], minMarks: number): number | null {
  if (!Number.isSafeInteger(minMarks) || minMarks < 1) throw new Error("invalid_min_marks");
  if (!Number.isSafeInteger(model.spamMessages) || !Number.isSafeInteger(model.hamMessages)) {
    throw new Error("invalid_class_count");
  }
  if (model.spamMessages < minMarks || model.hamMessages < minMarks) return null;
  return classify(tokens, model);
}

export function classify(tokens: readonly string[], model: BayesModel): number {
  if (!Number.isSafeInteger(model.spamMessages) || model.spamMessages < 0) throw new Error("invalid_spam_messages");
  if (!Number.isSafeInteger(model.hamMessages) || model.hamMessages < 0) throw new Error("invalid_ham_messages");
  const scored: Array<{ token: string; distance: number; probability: number }> = [];
  for (const token of tokens) {
    const row = model.tokens.get(token) ?? { spam: 0, ham: 0 };
    if (!Number.isSafeInteger(row.spam) || !Number.isSafeInteger(row.ham) || row.spam < 0 || row.ham < 0) {
      throw new Error("invalid_token_count");
    }
    const spamRate = (row.spam + 1) / (model.spamMessages + 2);
    const hamRate = (row.ham + 1) / (model.hamMessages + 2);
    const raw = spamRate / (spamRate + hamRate);
    const probability = Math.min(1 - TOKEN_CLAMP, Math.max(TOKEN_CLAMP, raw));
    scored.push({ token, distance: Math.abs(probability - 0.5), probability });
  }
  scored.sort((left, right) => right.distance - left.distance || (left.token < right.token ? -1 : left.token > right.token ? 1 : 0));
  let logOdds = 0;
  const selected = scored.slice(0, MAX_CLASSIFIER_TOKENS);
  for (const item of selected) {
    logOdds += Math.log(item.probability) - Math.log(1 - item.probability);
  }
  if (!Number.isFinite(logOdds)) throw new Error("invalid_log_odds");
  const posterior = 1 / (1 + Math.exp(-logOdds));
  if (!Number.isFinite(posterior)) throw new Error("invalid_posterior");
  return posterior;
}

function senderDomain(from: string): string | null {
  const trimmed = from.trim();
  const angle = /<([^<>\s]+)>/.exec(trimmed);
  const candidate = angle?.[1] ?? trimmed;
  if (!candidate.includes("@")) return null;
  try {
    const address = normalizeAddress(candidate);
    const domain = normalizeDomain(address.slice(address.lastIndexOf("@") + 1));
    if (!domain.includes(".") || domain.startsWith(".") || domain.includes("..")) return null;
    return domain;
  } catch {
    return null;
  }
}

function urlHosts(text: string): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();
  const matches = text.match(URL_PATTERN) ?? [];
  for (const raw of matches) {
    if (hosts.length >= MAX_URLS) break;
    let host = "";
    try {
      host = new URL(raw.replace(/[.,;:!?)]+$/g, "")).hostname.toLowerCase().replace(/\.$/, "");
    } catch {
      continue;
    }
    if (!host.includes(".") || host.startsWith(".") || host.includes("..") || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
}

function words(text: string): string[] {
  const found: string[] = [];
  const source = text.toLowerCase().replace(URL_PATTERN, " ");
  for (const match of source.matchAll(WORD_PATTERN)) {
    const word = match[0];
    if (!word || word.length < MIN_WORD_LENGTH || word.length > MAX_WORD_LENGTH) continue;
    if (!/[a-z]/.test(word)) continue;
    found.push(word);
  }
  return found;
}
