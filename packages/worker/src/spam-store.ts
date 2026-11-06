import {
  canonicalTokens,
  signalProbability,
  spamLearnEnabled,
  spamLearnMin,
  tokenizeMessage,
  trainingDelta,
  type BayesModel,
  type TrainingState,
} from "./spam-bayes.js";
import {
  applySpamFilter,
  resolveSpamConfig,
  scoreSpam,
  type ResolvedSpamConfig,
  type SpamAssessment,
  type SpamDisposition,
  type SpamLists,
  type SpamMode,
  type SpamRuleKind,
  type SpamScoreInput,
} from "./spam.js";
import type { Env, MessageRow } from "./types.js";
import { errorMentionsMissingSchema } from "./util.js";

const RULE_KINDS = new Set<SpamRuleKind>(["allow_sender", "block_sender", "allow_domain", "block_domain"]);

export interface SpamListEdit {
  inboxId: string;
  blockSender?: string;
  blockDomain?: string;
  allowSender?: string;
  allowDomain?: string;
}

export async function assessInbound(
  env: Env,
  inboxId: string,
  input: Omit<SpamScoreInput, "lists" | "threshold" | "recipientDomain" | "bayes">,
  labels: readonly string[],
): Promise<{ config: ResolvedSpamConfig; assessment: SpamAssessment; disposition: SpamDisposition }> {
  const loaded = await loadSpamContext(env, inboxId);
  const rulesInput = {
    ...input,
    recipientDomain: env.MAIL_DOMAIN,
    lists: loaded.lists,
    threshold: loaded.config.threshold,
  };
  const rules = scoreSpam(rulesInput);
  if (!spamLearnEnabled(env)) {
    return finishAssessment(loaded.config, rules, labels);
  }
  try {
    const spamProbability = await learnedProbability(env, inboxId, input);
    const assessment = scoreSpam({ ...rulesInput, bayes: { spamProbability } });
    return finishAssessment(loaded.config, assessment, labels);
  } catch (error) {
    // A classifier or count-store failure keeps the rules score. Mail is not dropped.
    console.error("spam_learn_failed", error instanceof Error ? error.name : "unknown");
    return finishAssessment(loaded.config, rules, labels);
  }
}

export interface SpamTrainingSummary {
  inbox_id: string;
  spam_messages: number;
  ham_messages: number;
  tokens: number;
  min_marks: number;
  learning: boolean;
  ready: boolean;
}

export async function readSpamTraining(env: Env, inboxId: string): Promise<SpamTrainingSummary> {
  const counts = await env.DB.prepare(
    "SELECT spam_messages, ham_messages FROM inbox_spam_class_counts WHERE inbox_id = ?",
  ).bind(inboxId).first<{ spam_messages: number; ham_messages: number }>();
  const tokens = await env.DB.prepare(
    "SELECT COUNT(*) AS tokens FROM inbox_spam_token_counts WHERE inbox_id = ?",
  ).bind(inboxId).first<{ tokens: number }>();
  const spamMessages = counts?.spam_messages ?? 0;
  const hamMessages = counts?.ham_messages ?? 0;
  const minMarks = spamLearnMin(env);
  const learning = spamLearnEnabled(env);
  return {
    inbox_id: inboxId,
    spam_messages: spamMessages,
    ham_messages: hamMessages,
    tokens: Number(tokens?.tokens ?? 0),
    min_marks: minMarks,
    learning,
    ready: learning && spamMessages >= minMarks && hamMessages >= minMarks,
  };
}

export async function planMessageTraining(
  env: Env,
  message: MessageRow,
  spam: boolean,
  now: string,
): Promise<D1PreparedStatement[]> {
  const tokens = canonicalTokens(tokenizeMessage({
    subject: message.subject,
    text: await trainingText(env, message),
    from: message.envelope_from,
  }));
  const existing = await env.DB.prepare(
    "SELECT label, tokens_json FROM message_spam_training WHERE message_id = ?",
  ).bind(message.id).first<{ label: string; tokens_json: string }>();
  const delta = trainingDelta(parseTrainingState(existing), { label: spam ? "spam" : "ham", tokens });
  if (delta.noop) return [];
  const statements: D1PreparedStatement[] = [];
  for (const row of delta.tokens) {
    statements.push(env.DB.prepare(
      `INSERT INTO inbox_spam_token_counts (inbox_id, token, spam_count, ham_count)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(inbox_id, token) DO UPDATE SET
         spam_count = spam_count + ?,
         ham_count = ham_count + ?`,
    ).bind(message.inbox_id, row.token, Math.max(row.spam, 0), Math.max(row.ham, 0), row.spam, row.ham));
  }
  if (delta.spamMessages !== 0 || delta.hamMessages !== 0) {
    statements.push(env.DB.prepare(
      `INSERT INTO inbox_spam_class_counts (inbox_id, spam_messages, ham_messages, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(inbox_id) DO UPDATE SET
         spam_messages = spam_messages + ?,
         ham_messages = ham_messages + ?,
         updated_at = excluded.updated_at`,
    ).bind(
      message.inbox_id,
      Math.max(delta.spamMessages, 0),
      Math.max(delta.hamMessages, 0),
      now,
      delta.spamMessages,
      delta.hamMessages,
    ));
  }
  statements.push(env.DB.prepare(
    `INSERT INTO message_spam_training (message_id, inbox_id, label, tokens_json, trained_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       inbox_id = excluded.inbox_id,
       label = excluded.label,
       tokens_json = excluded.tokens_json,
       trained_at = excluded.trained_at`,
  ).bind(message.id, message.inbox_id, spam ? "spam" : "ham", JSON.stringify(tokens), now));
  return statements;
}

export async function loadSpamContext(env: Env, inboxId: string): Promise<{ config: ResolvedSpamConfig; lists: SpamLists }> {
  return {
    config: resolveSpamConfig(env, await readSettings(env, inboxId)),
    lists: await readLists(env, inboxId),
  };
}

export function spamListStatements(env: Env, edit: SpamListEdit, now: string): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  const add = (kind: SpamRuleKind, value: string | undefined, opposite: SpamRuleKind) => {
    if (!value) return;
    statements.push(env.DB.prepare(
      "DELETE FROM inbox_spam_rules WHERE inbox_id = ? AND kind = ? AND value = ?",
    ).bind(edit.inboxId, opposite, value));
    statements.push(env.DB.prepare(
      "INSERT OR IGNORE INTO inbox_spam_rules (inbox_id, kind, value, created_at) VALUES (?, ?, ?, ?)",
    ).bind(edit.inboxId, kind, value, now));
  };
  add("block_sender", edit.blockSender, "allow_sender");
  add("block_domain", edit.blockDomain, "allow_domain");
  add("allow_sender", edit.allowSender, "block_sender");
  add("allow_domain", edit.allowDomain, "block_domain");
  return statements;
}

function finishAssessment(
  config: ResolvedSpamConfig,
  assessment: SpamAssessment,
  labels: readonly string[],
): { config: ResolvedSpamConfig; assessment: SpamAssessment; disposition: SpamDisposition } {
  return { config, assessment, disposition: applySpamFilter(config.mode, assessment, labels) };
}

async function learnedProbability(
  env: Env,
  inboxId: string,
  input: { from: string; subject: string | null; text: string },
): Promise<number | null> {
  const tokens = tokenizeMessage({ subject: input.subject, text: input.text, from: input.from });
  let model: BayesModel;
  try {
    model = await readBayesModel(env, inboxId, tokens);
  } catch (error) {
    if (missingLearnSchema(error)) return null;
    throw error;
  }
  return signalProbability(model, tokens, spamLearnMin(env));
}

async function readBayesModel(env: Env, inboxId: string, tokens: readonly string[]): Promise<BayesModel> {
  const counts = await env.DB.prepare(
    "SELECT spam_messages, ham_messages FROM inbox_spam_class_counts WHERE inbox_id = ?",
  ).bind(inboxId).first<{ spam_messages: number; ham_messages: number }>();
  const tokenCounts = new Map<string, { spam: number; ham: number }>();
  if (tokens.length > 0) {
    const placeholders = tokens.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT token, spam_count, ham_count FROM inbox_spam_token_counts WHERE inbox_id = ? AND token IN (${placeholders})`,
    ).bind(inboxId, ...tokens).all<{ token: string; spam_count: number; ham_count: number }>();
    for (const row of rows.results) tokenCounts.set(row.token, { spam: row.spam_count, ham: row.ham_count });
  }
  return {
    spamMessages: counts?.spam_messages ?? 0,
    hamMessages: counts?.ham_messages ?? 0,
    tokens: tokenCounts,
  };
}

async function trainingText(env: Env, message: MessageRow): Promise<string> {
  const excerpt = message.text_excerpt ?? "";
  if (message.body_truncated !== 1 || !message.parsed_r2_key) return excerpt;
  try {
    const object = await env.MAIL_BUCKET.get(message.parsed_r2_key);
    if (!object) return excerpt;
    const parsed = await object.json<{ text?: unknown }>();
    return typeof parsed.text === "string" ? parsed.text : excerpt;
  } catch {
    return excerpt;
  }
}

function parseTrainingState(row: { label: string; tokens_json: string } | null): TrainingState | null {
  if (!row) return null;
  if (row.label !== "spam" && row.label !== "ham") throw new Error("invalid_training_label");
  const parsed = JSON.parse(row.tokens_json) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((token) => typeof token === "string")) throw new Error("invalid_training_tokens");
  return { label: row.label, tokens: parsed };
}

export function missingLearnSchema(error: unknown): boolean {
  return ["inbox_spam_class_counts", "inbox_spam_token_counts", "message_spam_training"]
    .some((name) => errorMentionsMissingSchema(error, name));
}

async function readSettings(env: Env, inboxId: string): Promise<{ mode: SpamMode | null; threshold: number | null } | null> {
  try {
    return await env.DB.prepare(
      "SELECT mode, threshold FROM inbox_spam_settings WHERE inbox_id = ?",
    ).bind(inboxId).first<{ mode: SpamMode | null; threshold: number | null }>();
  } catch (error) {
    if (errorMentionsMissingSchema(error, "inbox_spam_settings")) return null;
    throw error;
  }
}

async function readLists(env: Env, inboxId: string): Promise<SpamLists> {
  const lists: SpamLists = { allowSenders: [], blockSenders: [], allowDomains: [], blockDomains: [] };
  let rows: Array<{ kind: string; value: string }>;
  try {
    const result = await env.DB.prepare(
      "SELECT kind, value FROM inbox_spam_rules WHERE inbox_id = ?",
    ).bind(inboxId).all<{ kind: string; value: string }>();
    rows = result.results;
  } catch (error) {
    if (errorMentionsMissingSchema(error, "inbox_spam_rules")) return lists;
    throw error;
  }
  const allowSenders: string[] = [];
  const blockSenders: string[] = [];
  const allowDomains: string[] = [];
  const blockDomains: string[] = [];
  for (const row of rows) {
    if (!RULE_KINDS.has(row.kind as SpamRuleKind)) continue;
    if (row.kind === "allow_sender") allowSenders.push(row.value);
    if (row.kind === "block_sender") blockSenders.push(row.value);
    if (row.kind === "allow_domain") allowDomains.push(row.value);
    if (row.kind === "block_domain") blockDomains.push(row.value);
  }
  return { allowSenders, blockSenders, allowDomains, blockDomains };
}
