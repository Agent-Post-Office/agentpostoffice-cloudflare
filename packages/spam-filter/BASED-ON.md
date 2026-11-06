# Source snapshot

This package matches APO main `8ccceaf` scoring:

- Repo: https://github.com/Agent-Post-Office/agentpostoffice-cloudflare
- Commit: `8ccceaf` (after #47 weight cap and #48 Bayes)
- Files ported: `packages/worker/src/spam.ts`, `packages/worker/src/spam-bayes.ts`, plus address helpers from `util.ts`
- Storage stays in the host behind `SpamStore` (`getRules`, `getClassCounts`, `getTokenCounts`)

Content weights are at most 19. Bayes contributes only after `SPAM_LEARN_MIN` (default 20) marks per class and a spam posterior of at least 0.90, capped at 52 points.

