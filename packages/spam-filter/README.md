# @agent-post-office/spam-filter

A small, dependency-light spam scorer for agent mailboxes. Pure TypeScript. Zero runtime dependencies. Runs in Cloudflare Workers, browsers, and Node.

Extracted from [Agent Post Office](https://github.com/Agent-Post-Office/agentpostoffice-cloudflare).

**Never drops mail.** This package only scores. Your app decides whether to tag, move to a spam folder, or leave the message alone.

> Status: v0.1.0. Not yet published to npm; install from this repo's `v0.1.0` tag for now.

Scorer matches APO main `8ccceaf`: content rules, Authentication-Results, allow/block lists, and Bayes from operator marks. The optional SpamAssassin rule add-on is **planned** and is not exported yet.

## Quick start

```bash
# Not published yet. After the first release:
npm install @agent-post-office/spam-filter
```

Until then, install from a git tag (builds `dist/` via `prepare`):

```json
"@agent-post-office/spam-filter": "github:Agent-Post-Office/agent-post-office-spam-filter#v0.1.0"
```

```ts
import {
  scoreMessage,
  applySpamFilter,
  tokenizeMessage,
  spamProbabilityFromStore,
  type SpamStore,
} from "@agent-post-office/spam-filter";

const assessment = scoreMessage({
  from: "seller@mg.example.com",
  subject: "We tested your site",
  text: "We noticed your product. Got 15 minutes? Book a demo.",
  authenticationResults: "mx.example.net; dkim=pass; spf=pass; dmarc=pass",
  recipientDomain: "example.com",
});

// assessment: { score: 0-100, reasons: string[], verdict: "spam" | "ham" }

const disposition = applySpamFilter("tag", assessment, []);
// tag mode: spam stays folder "inbox" with a "spam" label
// quarantine mode: spam uses folder "spam"
```

## How scoring works

Additive score from 0 to 100. The final score is `Math.min(100, sum)`. Verdict is spam when `score >= threshold`.

Default threshold is **60** (`DEFAULT_SPAM_THRESHOLD`). Callers pass `threshold` on `scoreSpam` / `scoreMessage`. In APO, `SPAM_THRESHOLD` overrides the default instance-wide, and `inbox_spam_settings.threshold` overrides that per inbox. `inbox_spam_settings.mode` also overrides the instance `SPAM_FILTER` mode per inbox.

The package never rejects mail. Callers map the verdict with `applySpamFilter`.

### Allow and block lists (checked first)

| Signal | Effect |
| --- | --- |
| Exact sender block | score 100, spam |
| Exact sender allow | score 0, ham |
| Domain block (exact or subdomain) | score 100, spam |
| Domain allow | score 0, ham |

### Authentication-Results

| Signal | Points |
| --- | --- |
| `dmarc=fail` | +40 |
| `spf=fail` | +20 |
| `dkim=fail` | +20 |
| `spf=softfail` | +10 |

`pass` never adds points. A single auth failure alone stays under 60 when the threshold is 60.

### Content rules

Each content weight is at most **19**, so one content rule stays ham on its own and stays ham with one authentication failure (largest auth failure is DMARC fail at 40: `19 + 40 = 59`). There is **no** cap on how many content rules may fire together; only the total score is clamped to 100.

| Rule | Points | Notes |
| --- | --- | --- |
| `cold_audit` | +19 | Subject matches "we tested your" |
| `outreach_opener` | +14 | Cold-outreach openers |
| `meeting_ask` | +16 | Asks for minutes / a call / a demo |
| `marketing_subdomain` | +12 | Marketing-style subdomain plus a pitch |
| `unrelated_incident` | +12 | Downtime/outage subject naming another host, plus a pitch |
| `verification_subject` | +16 | Verify / confirm email or account |
| `urgency_notice` | +8 | "Important notice" with a verification subject |
| `freemail_verification` | +8 | Freemail sender with a verification subject |
| `empty_verification_body` | +10 | Empty body with a verification subject |

Exports: `CONTENT_RULE_WEIGHTS`, `AUTH_FAILURE_WEIGHTS`, `verdictForScore`.

Cloudflare Email Routing already rejects many blocklisted IPs before the Worker runs. This package targets authenticated cold sales and phishing-style verification notices that still pass DKIM and DMARC.

### Bayes from operator marks

Bayes is one more additive signal on the same 0-100 score.

| Gate | Behavior |
| --- | --- |
| Marks per class | Contributes nothing until each class has at least `SPAM_LEARN_MIN` marks (default **20**) |
| Posterior floor | Contributes nothing when spam probability is below **0.90** |
| Points | `round(52 * (p - 0.90) / 0.10)`, capped at **52** (`BAYES_CAP`) |
| Ham posteriors | Add no points (learning cannot hide a rules hit) |

Use the same tokenizer for training and scoring:

```ts
import { tokenizeMessage, canonicalTokens, trainingDelta, signalProbability } from "@agent-post-office/spam-filter";

const tokens = canonicalTokens(tokenizeMessage({ from, subject, text }));
```

Hosts keep storage. Implement `SpamStore` and call `spamProbabilityFromStore` / `scoreWithStore`, or pass `{ bayes: { spamProbability } }` into `scoreSpam` after loading counts yourself.

## Results

Illustrative local runs use `example.com` addresses only.

| Case | Score | Verdict | Notes |
| --- | --- | --- | --- |
| Plain message, auth pass | **0** | ham | No content or auth signals |
| Crafted cold-pitch + verification copy | **93** | spam | 7 content rules |

Live APO check on one production instance (read-only, 2026-11-06, Asia/Jerusalem), Worker on main `8ccceaf` with `SPAM_FILTER=tag` and `SPAM_LEARN=on`:

| Probe | Score | Verdict | Reasons | Received (Asia/Jerusalem) |
| --- | --- | --- | --- | --- |
| Ham | **0** | ham | (none) | 12:48:19 |
| Spam | **93** | spam | same 7 content rules | 14:27:57 |

Tag mode kept both messages in the inbox; the spam probe received the `spam` label. No message content or addresses are included here.

## Why this package exists

Worker-side research (2026-11-06) found no drop-in replacement for authenticated cold B2B pitches:

| Option | Finding |
| --- | --- |
| SpamGuard | Bundles for Workers; scored an APO-shaped cold pitch at **0.3 / not spam** |
| formshield-ai | Aimed at form spam, not mailbox cold pitches |
| spamscanner | **BUSL-1.1**; needs Node built-ins; does not bundle cleanly for Workers |
| Bayes libraries (`bayes`, `nbayes`, classificator, wink) | Run in a Worker; useful as a learning layer, which this package now includes as pure functions |
| SpamAssassin / rspamd hosts | Need an external process; not a pure Worker library |

A portable SpamAssassin rule subset was measured separately:

- **322** active scoring rules after translation
- Worker bundle about **683 KB**
- Median about **3.6 ms** per message in the local harness
- **14.7%** recall on a public SpamAssassin corpus
- **0** on the available real APO spam snapshots

That is why SpamAssassin rules are planned as an **optional add-on**, not the core scorer.

## Optional SpamAssassin add-on (planned)

Not included in this package yet. When it ships:

- Optional subpath or separate entry, off by default
- Keeps the Apache Software Foundation **NOTICE** and rule attributions
- Remains explainable (rule hits), Worker-safe, and fail-open
- Does not replace allow/block lists, auth signals, or Bayes

See `NOTICE`.

## Install

```bash
npm install @agent-post-office/spam-filter
```

Not on npm yet. Install from the git tag:

```json
"@agent-post-office/spam-filter": "github:Agent-Post-Office/agent-post-office-spam-filter#v0.1.0"
```

The package `prepare` script runs `tsc` so git installs build `dist/`.

## Usage

```ts
import {
  scoreSpam,
  scoreMessage,
  parseAuthenticationResults,
  applySpamFilter,
  resolveSpamConfig,
  tokenizeMessage,
  signalProbability,
  bayesContribution,
  spamProbabilityFromStore,
  scoreWithStore,
  type SpamStore,
  CONTENT_RULE_WEIGHTS,
  AUTH_FAILURE_WEIGHTS,
  BAYES_CAP,
  DEFAULT_SPAM_LEARN_MIN,
} from "@agent-post-office/spam-filter";

const assessment = scoreMessage(
  {
    from: message.from,
    subject: message.headers.get("subject"),
    text: plainTextBody,
    authenticationResults: message.headers.get("authentication-results"),
    recipientDomain: "example.com",
  },
  {
    threshold: 60,
    lists: {
      allowSenders: [],
      blockSenders: [],
      allowDomains: [],
      blockDomains: [],
    },
  },
);

const { mode, threshold } = resolveSpamConfig({
  SPAM_FILTER: "tag",
  SPAM_THRESHOLD: "60",
});

const disposition = applySpamFilter(mode, assessment, existingLabels);
```

### API

| Export | Purpose |
| --- | --- |
| `scoreMessage(input, options?)` | Score one message. Defaults threshold 60 and empty lists. |
| `scoreSpam(input)` | Same scorer with an explicit `SpamScoreInput` (includes optional `bayes`). |
| `parseAuthenticationResults(header)` | Parse `Authentication-Results` into dkim/spf/dmarc states. |
| `applySpamFilter(mode, assessment, labels)` | Map a verdict to folder + labels. Modes: `off`, `tag`, `quarantine`. |
| `resolveSpamConfig(env, inbox?)` | Resolve mode and threshold from env and per-inbox overrides. |
| `verdictForScore(score, threshold)` | `spam` when score >= threshold, else `ham`. |
| `tokenizeMessage(input)` | Tokenize for training and Bayes scoring (same function). |
| `canonicalTokens` / `trainingDelta` | Training helpers for host mark/backfill paths. |
| `signalProbability(model, tokens, minMarks)` | Posterior or `null` when under the mark gate. |
| `classify(tokens, model)` | Raw posterior. |
| `bayesContribution(probability)` | Points + `bayes_spam_p` reason, or nothing below 0.90. |
| `spamLearnEnabled` / `spamLearnMin` | Parse `SPAM_LEARN` / `SPAM_LEARN_MIN`. |
| `SpamStore` / `spamProbabilityFromStore` / `scoreWithStore` | Host storage interface and helpers. |
| `CONTENT_RULE_WEIGHTS` / `AUTH_FAILURE_WEIGHTS` / `BAYES_CAP` | Weight tables and Bayes cap. |
| `spamFlagged(disposition)` | True when folder is spam or labels include spam. |

## Configuration reference

### Package options

| Option | Default | Meaning |
| --- | --- | --- |
| `threshold` | `60` | Spam when `score >= threshold`. Passed on `scoreSpam` / `scoreMessage`. |
| `lists.allowSenders` | `[]` | Exact sender addresses forced to ham |
| `lists.blockSenders` | `[]` | Exact sender addresses forced to spam |
| `lists.allowDomains` | `[]` | Sender domains (and subdomains) forced to ham |
| `lists.blockDomains` | `[]` | Sender domains (and subdomains) forced to spam |
| `bayes.spamProbability` | omitted | Optional posterior from the host; omitted/null adds nothing |

`resolveSpamConfig` reads:

| Input | Default | Meaning |
| --- | --- | --- |
| `env.SPAM_FILTER` / per-inbox `mode` | `tag` | `off`, `tag`, or `quarantine` |
| `env.SPAM_THRESHOLD` / per-inbox `threshold` | `60` | Integer 0 to 100 |

### How Agent Post Office wires this in

These settings live in the APO Worker host. The package stays storage-free.

| APO setting | Meaning |
| --- | --- |
| `SPAM_FILTER=off` | Score may still be stored; disposition stays inbox with no spam label |
| `SPAM_FILTER=tag` | Default. Automatic spam verdict keeps `folder=inbox` and adds the `spam` label |
| `SPAM_FILTER=quarantine` | Automatic spam verdict sets `folder=spam` and adds the `spam` label |
| `SPAM_THRESHOLD` | Instance-wide threshold override (default 60) |
| `inbox_spam_settings.threshold` | Per-inbox threshold override |
| `inbox_spam_settings.mode` | Per-inbox mode override |
| `SPAM_LEARN=on` | Enables Bayes training and scoring (code default is off) |
| `SPAM_LEARN_MIN` | Minimum operator marks per class before Bayes contributes (default 20) |

Operator marks and lists in APO:

- REST, MCP, and CLI mark spam / not-spam and manage allow/block lists
- **Mark-spam always moves the message to the spam folder**, even when automatic mode is `tag`
- Automatic tag mode only affects inbound scoring disposition (inbox + label), not the explicit mark-spam action
- Backfill: `POST /v1/inboxes/{id}/spam-training`, MCP `backfill_spam_training`, and CLI. Default page size **25**, maximum **100**. Idempotent; operator marks only

## What stays in the host app

- Storage for messages, folders, sender lists, token counts, and class counts (`SpamStore`)
- Mark spam / not-spam tools and backfill
- Queue parse wiring and MIME parsing
- Optional SpamAssassin add-on (**planned**)

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
