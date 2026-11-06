/**
 * Storage interface for host apps (APO keeps D1 behind this).
 * Methods may be sync or async.
 */
import {
  DEFAULT_SPAM_LEARN_MIN,
  signalProbability,
  tokenizeMessage,
  type BayesModel,
} from "./bayes.js";
import {
  DEFAULT_SPAM_THRESHOLD,
  resolveSpamConfig,
  scoreSpam,
  type ResolvedSpamConfig,
  type SpamAssessment,
  type SpamLists,
  type SpamScoreInput,
} from "./rules.js";

export interface SpamClassCounts {
  spamMessages: number;
  hamMessages: number;
}

export interface SpamTokenCount {
  spam: number;
  ham: number;
}

/**
 * Host-implemented storage. APO wires these to D1 tables
 * `inbox_spam_rules`, `inbox_spam_token_counts`, and `inbox_spam_class_counts`.
 */
export interface SpamStore {
  /** Allow and block lists for one inbox. */
  getRules(inboxId: string): SpamLists | Promise<SpamLists>;
  /** Per-class trained message counts. */
  getClassCounts(inboxId: string): SpamClassCounts | Promise<SpamClassCounts>;
  /**
   * Token counts for the tokens the scorer will use.
   * Hosts may return only the requested tokens (APO does).
   */
  getTokenCounts(
    inboxId: string,
    tokens: readonly string[],
  ): ReadonlyMap<string, SpamTokenCount> | Promise<ReadonlyMap<string, SpamTokenCount>>;
}

async function resolve<T>(value: T | Promise<T>): Promise<T> {
  return value;
}

/** Build a {@link BayesModel} from a {@link SpamStore}. */
export async function loadBayesModel(
  store: SpamStore,
  inboxId: string,
  tokens: readonly string[],
): Promise<BayesModel> {
  const counts = await resolve(store.getClassCounts(inboxId));
  const tokenCounts = await resolve(store.getTokenCounts(inboxId, tokens));
  return {
    spamMessages: counts.spamMessages,
    hamMessages: counts.hamMessages,
    tokens: tokenCounts,
  };
}

/**
 * Tokenize then score Bayes probability through the store.
 * Returns null when either class is below minMarks (default 20).
 */
export async function spamProbabilityFromStore(
  store: SpamStore,
  inboxId: string,
  input: { from: string; subject: string | null; text: string },
  minMarks: number = DEFAULT_SPAM_LEARN_MIN,
): Promise<number | null> {
  const tokens = tokenizeMessage(input);
  const model = await loadBayesModel(store, inboxId, tokens);
  return signalProbability(model, tokens, minMarks);
}

export interface ScoreWithStoreInput {
  from: string;
  subject: string | null;
  text: string;
  authenticationResults: string | null;
  recipientDomain: string;
  threshold?: number;
  /** When false, skip Bayes even if the store has counts. Default true. */
  learn?: boolean;
  minMarks?: number;
}

/**
 * Load lists (and optional Bayes) from a store, then score.
 * Hosts that already computed a probability can call {@link scoreSpam} directly.
 */
export async function scoreWithStore(
  store: SpamStore,
  inboxId: string,
  input: ScoreWithStoreInput,
): Promise<{ lists: SpamLists; assessment: SpamAssessment; spamProbability: number | null }> {
  const lists = await resolve(store.getRules(inboxId));
  const threshold = input.threshold ?? DEFAULT_SPAM_THRESHOLD;
  const base: SpamScoreInput = {
    from: input.from,
    subject: input.subject,
    text: input.text,
    authenticationResults: input.authenticationResults,
    recipientDomain: input.recipientDomain,
    lists,
    threshold,
  };
  if (input.learn === false) {
    return { lists, assessment: scoreSpam(base), spamProbability: null };
  }
  const spamProbability = await spamProbabilityFromStore(
    store,
    inboxId,
    input,
    input.minMarks ?? DEFAULT_SPAM_LEARN_MIN,
  );
  return {
    lists,
    assessment: scoreSpam({ ...base, bayes: { spamProbability } }),
    spamProbability,
  };
}

export async function resolveConfigWithSettings(
  env: { SPAM_FILTER?: string; SPAM_THRESHOLD?: string },
  inbox?: { mode?: string | null; threshold?: number | null } | null,
): Promise<ResolvedSpamConfig> {
  return resolveSpamConfig(env, inbox);
}
