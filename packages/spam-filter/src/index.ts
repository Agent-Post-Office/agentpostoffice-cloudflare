/**
 * @agent-post-office/spam-filter
 *
 * Worker-safe additive email spam scorer used by Agent Post Office.
 * Pure TypeScript. Zero runtime dependencies. Never drops mail.
 *
 * Scoring core matches APO main 8ccceaf (rules + Bayes). Hosts keep storage.
 */

export {
  normalizeAddress,
  normalizeDomain,
} from "./util.js";

export {
  DEFAULT_SPAM_MODE,
  DEFAULT_SPAM_THRESHOLD,
  SPAM_LABEL,
  CONTENT_RULE_WEIGHTS,
  AUTH_FAILURE_WEIGHTS,
  resolveSpamConfig,
  scoreSpam,
  scoreMessage,
  verdictForScore,
  spamFlagged,
  applySpamFilter,
  labelsForSpamFolder,
  parseReasonList,
  withOperatorMark,
  operatorMarkLabel,
  mergeAuthenticationResults,
  domainOf,
  parseAuthenticationResults,
  type SpamMode,
  type SpamVerdict,
  type SpamRuleKind,
  type SpamLists,
  type SpamScoreInput,
  type SpamAssessment,
  type ResolvedSpamConfig,
  type SpamDisposition,
  type ScoreMessageOptions,
} from "./rules.js";

export {
  BAYES_CAP,
  BAYES_SPAM_FLOOR,
  DEFAULT_SPAM_LEARN_MIN,
  MAX_SUBJECT_CHARS,
  MAX_BODY_CHARS,
  MAX_TOKENS,
  MAX_URLS,
  MAX_WORD_LENGTH,
  MAX_FEATURE_LENGTH,
  MAX_CLASSIFIER_TOKENS,
  spamLearnEnabled,
  spamLearnMin,
  bayesContribution,
  tokenizeMessage,
  canonicalTokens,
  trainingDelta,
  signalProbability,
  classify,
  type BayesSignal,
  type BayesModel,
  type TrainingState,
  type TokenCountDelta,
  type TrainingDelta,
} from "./bayes.js";

export {
  loadBayesModel,
  spamProbabilityFromStore,
  scoreWithStore,
  resolveConfigWithSettings,
  type SpamStore,
  type SpamClassCounts,
  type SpamTokenCount,
  type ScoreWithStoreInput,
} from "./store.js";
