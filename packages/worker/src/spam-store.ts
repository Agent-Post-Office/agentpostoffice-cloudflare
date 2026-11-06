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
import type { Env } from "./types.js";
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
  input: Omit<SpamScoreInput, "lists" | "threshold" | "recipientDomain">,
  labels: readonly string[],
): Promise<{ config: ResolvedSpamConfig; assessment: SpamAssessment; disposition: SpamDisposition }> {
  const loaded = await loadSpamContext(env, inboxId);
  const assessment = scoreSpam({
    ...input,
    recipientDomain: env.MAIL_DOMAIN,
    lists: loaded.lists,
    threshold: loaded.config.threshold,
  });
  return {
    config: loaded.config,
    assessment,
    disposition: applySpamFilter(loaded.config.mode, assessment, labels),
  };
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
