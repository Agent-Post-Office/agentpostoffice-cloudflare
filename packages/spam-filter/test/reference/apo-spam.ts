/** Verbatim APO 8ccceaf spam.ts for parity tests. */
import { bayesContribution, type BayesSignal } from "./apo-spam-bayes.js";
import { normalizeAddress, normalizeDomain } from "./util.js";

export const DEFAULT_SPAM_MODE = "tag" as const;
export const DEFAULT_SPAM_THRESHOLD = 60;
export const SPAM_LABEL = "spam";

export type SpamMode = "off" | "tag" | "quarantine";
export type SpamVerdict = "spam" | "ham";
export type SpamRuleKind = "allow_sender" | "block_sender" | "allow_domain" | "block_domain";

export interface SpamLists {
  allowSenders: readonly string[];
  blockSenders: readonly string[];
  allowDomains: readonly string[];
  blockDomains: readonly string[];
}

export interface SpamScoreInput {
  from: string;
  subject: string | null;
  text: string;
  authenticationResults: string | null;
  recipientDomain: string;
  lists: SpamLists;
  threshold: number;
  // Omitted, null, or a null probability leaves the rules score unchanged.
  bayes?: BayesSignal | null;
}

export interface SpamAssessment {
  score: number;
  reasons: string[];
  verdict: SpamVerdict;
}

export interface ResolvedSpamConfig {
  mode: SpamMode;
  threshold: number;
}

export interface SpamDisposition {
  folder: "inbox" | "spam";
  labels: string[];
}

const FREEMAIL_DOMAINS = new Set([
  "aol.com",
  "gmail.com",
  "gmx.com",
  "gmx.net",
  "googlemail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mail.ru",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "yahoo.co.uk",
  "yahoo.com",
  "ya.ru",
  "yandex.com",
  "yandex.ru",
]);

const MARKETING_LABELS = new Set(["click", "em", "ems", "mailer", "marketing", "mg", "mkt", "news", "send"]);

// One content rule stays ham on its own, and stays ham with one authentication
// failure. The largest auth failure is DMARC fail at 40, so each content
// weight is at most 19: 19 + 40 = 59, under the default threshold of 60.
// Authentication weights are unchanged; the content cap holds the rule.
// cold_audit is the most specific pitch phrase, so it takes the cap.
// meeting_ask and verification_subject are the next most specific.
// outreach_opener is a common opener and weighs less.
// marketing_subdomain and unrelated_incident only count beside a pitch.
// The three verification extras only count beside a verification subject.
export const CONTENT_RULE_WEIGHTS = {
  cold_audit: 19,
  outreach_opener: 14,
  meeting_ask: 16,
  marketing_subdomain: 12,
  unrelated_incident: 12,
  verification_subject: 16,
  urgency_notice: 8,
  freemail_verification: 8,
  empty_verification_body: 10,
} as const;

export const AUTH_FAILURE_WEIGHTS = {
  auth_dmarc_fail: 40,
  auth_spf_fail: 20,
  auth_dkim_fail: 20,
  auth_spf_softfail: 10,
} as const;

const COLD_AUDIT = /\bwe tested your\b/i;
const OUTREACH_OPENER = /\b(?:we|i) (?:noticed|came across|saw that)\b|\bsaw your\b|\bchecking in\b/i;
const MEETING_ASK = /\b(?:got|have|spare|grab)\s+\d*\s*minutes?\b|\b(?:quick call|hop on a call|jump on a call|book a (?:demo|call|time)|schedule a (?:call|demo|chat))\b/i;
const INCIDENT_SUBJECT = /\b(?:downtime|outage)\b|\bis down\b/i;
const VERIFICATION_SUBJECT = /email address verification|verify your (?:e-?mail|account|address)|confirm your (?:e-?mail|account)|account verification/i;
const URGENCY_NOTICE = /\bimportant notice\b/i;

export function resolveSpamConfig(
  env: { SPAM_FILTER?: string; SPAM_THRESHOLD?: string },
  inbox?: { mode?: string | null; threshold?: number | null } | null,
): ResolvedSpamConfig {
  return {
    mode: parseMode(inbox?.mode) ?? parseMode(env.SPAM_FILTER) ?? DEFAULT_SPAM_MODE,
    threshold: parseThreshold(inbox?.threshold) ?? parseThreshold(env.SPAM_THRESHOLD) ?? DEFAULT_SPAM_THRESHOLD,
  };
}

export function scoreSpam(input: SpamScoreInput): SpamAssessment {
  const from = senderAddress(input.from);
  const domain = from ? domainOf(from) : null;
  const allowSenders = normalizeSenders(input.lists.allowSenders);
  const blockSenders = normalizeSenders(input.lists.blockSenders);

  if (from && blockSenders.includes(from)) return decided(100, ["block_sender"], "spam");
  if (from && allowSenders.includes(from)) return decided(0, ["allow_sender"], "ham");
  if (domainListed(domain, input.lists.blockDomains)) return decided(100, ["block_domain"], "spam");
  if (domainListed(domain, input.lists.allowDomains)) return decided(0, ["allow_domain"], "ham");

  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };

  const auth = authenticationSignals(input.authenticationResults);
  if (auth.dmarc === "fail") add(AUTH_FAILURE_WEIGHTS.auth_dmarc_fail, "auth_dmarc_fail");
  if (auth.spf === "fail") add(AUTH_FAILURE_WEIGHTS.auth_spf_fail, "auth_spf_fail");
  if (auth.dkim === "fail") add(AUTH_FAILURE_WEIGHTS.auth_dkim_fail, "auth_dkim_fail");
  if (auth.spf === "softfail") add(AUTH_FAILURE_WEIGHTS.auth_spf_softfail, "auth_spf_softfail");

  const subject = input.subject ?? "";
  const text = input.text ?? "";
  const combined = `${subject}\n${text}`;
  const coldAudit = COLD_AUDIT.test(subject);
  const outreach = OUTREACH_OPENER.test(combined);
  const meeting = MEETING_ASK.test(combined);
  const verification = VERIFICATION_SUBJECT.test(subject);
  const pitched = coldAudit || outreach || meeting;

  if (coldAudit) add(CONTENT_RULE_WEIGHTS.cold_audit, "cold_audit");
  if (outreach) add(CONTENT_RULE_WEIGHTS.outreach_opener, "outreach_opener");
  if (meeting) add(CONTENT_RULE_WEIGHTS.meeting_ask, "meeting_ask");
  if (pitched && marketingSubdomain(domain, input.recipientDomain)) add(CONTENT_RULE_WEIGHTS.marketing_subdomain, "marketing_subdomain");
  if (pitched && unrelatedIncident(subject, domain)) add(CONTENT_RULE_WEIGHTS.unrelated_incident, "unrelated_incident");
  if (verification) add(CONTENT_RULE_WEIGHTS.verification_subject, "verification_subject");
  if (verification && URGENCY_NOTICE.test(subject)) add(CONTENT_RULE_WEIGHTS.urgency_notice, "urgency_notice");
  if (verification && domain !== null && FREEMAIL_DOMAINS.has(domain)) add(CONTENT_RULE_WEIGHTS.freemail_verification, "freemail_verification");
  if (verification && text.trim().length === 0) add(CONTENT_RULE_WEIGHTS.empty_verification_body, "empty_verification_body");

  // Weight choice lives on BAYES_CAP in spam-bayes.ts. Absent input adds nothing.
  const learned = bayesContribution(input.bayes?.spamProbability);
  if (learned.points > 0 && learned.reason) add(learned.points, learned.reason);

  const bounded = Math.min(100, score);
  return { score: bounded, reasons, verdict: verdictForScore(bounded, input.threshold) };
}

// Spam at or above the threshold. 59 is ham and 60 is spam when the threshold is 60.
export function verdictForScore(score: number, threshold: number): SpamVerdict {
  return score >= threshold ? "spam" : "ham";
}

export function spamFlagged(disposition: SpamDisposition): boolean {
  return disposition.folder === "spam" || disposition.labels.includes(SPAM_LABEL);
}

export function applySpamFilter(mode: SpamMode, assessment: SpamAssessment, labels: readonly string[]): SpamDisposition {
  if (mode === "off") return { folder: "inbox", labels: [...labels] };
  if (assessment.verdict !== "spam") return { folder: "inbox", labels: labelsForSpamFolder(labels, false) };
  return {
    folder: mode === "quarantine" ? "spam" : "inbox",
    labels: labelsForSpamFolder(labels, true),
  };
}

export function labelsForSpamFolder(labels: readonly string[], spam: boolean): string[] {
  const rest = labels.filter((label) => label !== SPAM_LABEL);
  if (!spam) return rest.slice(0, 20);
  return [...rest.slice(0, 19), SPAM_LABEL];
}

export function parseReasonList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

export function withOperatorMark(value: string | null | undefined): string[] {
  const reasons = parseReasonList(value);
  if (!reasons.includes("operator_mark")) reasons.push("operator_mark");
  return reasons;
}

// The mark routes record a class as this triple: operator_mark, the verdict, and the folder.
// A flipped mark keeps only the final triple. Auto-scored mail has no operator_mark.
export function operatorMarkLabel(message: {
  folder?: string | null;
  spam_verdict?: string | null;
  spam_reasons_json?: string | null;
}): "spam" | "ham" | null {
  if (!parseReasonList(message.spam_reasons_json).includes("operator_mark")) return null;
  if (message.spam_verdict === "spam" && message.folder === "spam") return "spam";
  if (message.spam_verdict === "ham" && message.folder === "inbox") return "ham";
  return null;
}

export function mergeAuthenticationResults(
  headers: readonly { key?: string; value?: string }[],
  stored: Record<string, string>,
): string | null {
  const parsed = headers
    .filter((header) => header.key?.toLowerCase() === "authentication-results" && header.value?.trim())
    .map((header) => header.value!.trim())
    .join("\n");
  const value = (parsed || stored["authentication-results"] || "").slice(0, 8_192);
  if (!value) return null;
  stored["authentication-results"] = value;
  return value;
}

export function domainOf(address: string): string {
  return normalizeDomain(address.slice(address.lastIndexOf("@") + 1));
}

function decided(score: number, reasons: string[], verdict: SpamVerdict): SpamAssessment {
  return { score, reasons, verdict };
}

function parseMode(value: unknown): SpamMode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "off" || normalized === "tag" || normalized === "quarantine") return normalized;
  return null;
}

function parseThreshold(value: unknown): number | null {
  if (typeof value === "number") return integerThreshold(value);
  if (typeof value !== "string" || value.trim() === "") return null;
  return integerThreshold(Number(value));
}

function integerThreshold(value: number): number | null {
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

function senderAddress(from: string): string | null {
  const trimmed = from.trim();
  const angle = /<([^<>\s]+)>/.exec(trimmed);
  const candidate = angle?.[1] ?? trimmed;
  try {
    return normalizeAddress(candidate);
  } catch {
    return null;
  }
}

function normalizeSenders(values: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const value of values) {
    const address = senderAddress(value);
    if (address) normalized.push(address);
  }
  return normalized;
}

function domainListed(domain: string | null, rules: readonly string[]): boolean {
  if (!domain) return false;
  return rules.some((rule) => {
    const normalized = normalizeDomain(rule);
    if (!normalized.includes(".") || normalized.startsWith(".") || normalized.includes("..")) return false;
    return domain === normalized || domain.endsWith(`.${normalized}`);
  });
}

function marketingSubdomain(domain: string | null, recipientDomain: string): boolean {
  if (!domain) return false;
  const recipient = normalizeDomain(recipientDomain);
  if (!recipient || domain === recipient || domain.endsWith(`.${recipient}`)) return false;
  const label = domain.split(".")[0];
  return Boolean(label && MARKETING_LABELS.has(label));
}

function unrelatedIncident(subject: string, senderDomain: string | null): boolean {
  if (!senderDomain || !INCIDENT_SUBJECT.test(subject)) return false;
  const hosts = subject.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) ?? [];
  return hosts.some((host) => {
    const normalized = normalizeDomain(host);
    if (!normalized.includes(".")) return false;
    if (normalized === senderDomain || normalized.endsWith(`.${senderDomain}`)) return false;
    if (senderDomain.endsWith(`.${normalized}`)) return false;
    return true;
  });
}

type AuthState = "pass" | "fail" | "softfail" | "other" | null;

function authenticationSignals(header: string | null): { dkim: AuthState; spf: AuthState; dmarc: AuthState } {
  const found: Record<"dkim" | "spf" | "dmarc", Set<string>> = {
    dkim: new Set(),
    spf: new Set(),
    dmarc: new Set(),
  };
  if (header) {
    const pattern = /\b(dkim|spf|dmarc)\s*=\s*(pass|fail|softfail|neutral|none|temperror|permerror|bestguesspass)\b/gi;
    for (const match of header.matchAll(pattern)) {
      const mechanism = match[1]?.toLowerCase();
      const result = match[2]?.toLowerCase();
      if ((mechanism === "dkim" || mechanism === "spf" || mechanism === "dmarc") && result) {
        found[mechanism].add(result);
      }
    }
  }
  const prefer = (values: Set<string>): AuthState => {
    if (values.has("pass") || values.has("bestguesspass")) return "pass";
    if (values.has("fail")) return "fail";
    if (values.has("softfail")) return "softfail";
    if (values.size === 0) return null;
    return "other";
  };
  return { dkim: prefer(found.dkim), spf: prefer(found.spf), dmarc: prefer(found.dmarc) };
}
