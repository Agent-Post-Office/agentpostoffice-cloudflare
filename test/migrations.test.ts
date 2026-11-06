import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("archive and thread-list migrations", () => {
  it("adds nullable archived_at in 0005 and the thread feed index afterward, without backfill", () => {
    const files = readdirSync("packages/worker/migrations").filter((file) => file.endsWith(".sql")).sort();
    expect(files).toEqual([
      "0001_initial.sql",
      "0002_sieve_automation.sql",
      "0003_message_threads.sql",
      "0004_message_replied.sql",
      "0005_message_archived.sql",
      "0006_message_thread_feed.sql",
      "0007_message_spam.sql",
      "0008_spam_learn.sql",
    ]);

    const column = statements("packages/worker/migrations/0005_message_archived.sql");
    expect(column).toBe("ALTER TABLE messages ADD COLUMN archived_at TEXT;");
    expect(column).not.toMatch(/\b(UPDATE|NOT NULL|DEFAULT)\b/i);

    const index = statements("packages/worker/migrations/0006_message_thread_feed.sql");
    expect(index).toMatch(/^CREATE INDEX IF NOT EXISTS messages_thread_feed_idx ON messages \(thread_id,.*received_at, id\);$/);
    expect(index).not.toMatch(/\b(UPDATE|ALTER TABLE|INDEXED BY)\b/i);

    const spam = statements("packages/worker/migrations/0007_message_spam.sql");
    expect(spam).toContain("ADD COLUMN folder TEXT NOT NULL DEFAULT 'inbox'");
    expect(spam).toContain("ADD COLUMN spam_score INTEGER");
    expect(spam).toContain("ADD COLUMN spam_reasons_json TEXT");
    expect(spam).toContain("ADD COLUMN spam_verdict TEXT");
    expect(spam).toContain("CREATE TABLE inbox_spam_settings");
    expect(spam).toContain("CREATE TABLE inbox_spam_rules");
    expect(spam).toContain("messages_open_inbox_feed_idx");
    expect(spam).toContain("messages_open_spam_feed_idx");
    expect(spam).not.toMatch(/\b(UPDATE|DELETE|DROP)\b/i);

    const learn = statements("packages/worker/migrations/0008_spam_learn.sql");
    expect(learn).toContain("CREATE TABLE inbox_spam_class_counts");
    expect(learn).toContain("CREATE TABLE inbox_spam_token_counts");
    expect(learn).toContain("CREATE TABLE message_spam_training");
    expect(learn).not.toMatch(/\b(UPDATE|DELETE|DROP|ALTER TABLE messages)\b/i);
  });

  it("documents that archive routes need 0005 and the default feed does not", () => {
    const upgrading = readFileSync("docs/UPGRADING.md", "utf8");
    const readme = readFileSync("README.md", "utf8");
    expect(upgrading).toContain("0005_message_archived.sql");
    expect(upgrading).toContain("0006_message_thread_feed.sql");
    expect(upgrading).toMatch(/HTTP 503/);
    expect(upgrading).toContain("migration_pending");
    expect(upgrading).toContain("archived_at");
    expect(readme).toContain("thread_id");
    expect(readme).toContain("exact match");
    expect(readme).toContain("Archived messages stay in the default feed");
    expect(readme).toContain("--unanswered");
    expect(readme).toContain("--thread");
    expect(readme).toContain("--unarchived");
    expect(upgrading).toContain("0007_message_spam.sql");
    expect(upgrading).toContain("folder requires migration 0007");
    expect(readme).toContain("SPAM_FILTER");
    expect(readme).toContain("SPAM_THRESHOLD");
    expect(readme).toContain("folder=inbox|spam|all");
    expect(readme).toContain("score greater than or equal to the threshold");
    expect(readme).toContain("block_sender");
    expect(readme).toContain("--folder");
    expect(readme).toContain("messages spam");
    expect(upgrading).toContain("messages_open_inbox_feed_idx");
    expect(upgrading).toContain("does not backfill scores");
    expect(upgrading).toContain("DROP TABLE IF EXISTS inbox_spam_rules");
    expect(upgrading).toContain("DELETE FROM d1_migrations WHERE name = '0007_message_spam.sql'");
    expect(upgrading).toContain("0008_spam_learn.sql");
    expect(upgrading).toContain("spam training requires migration 0008");
    expect(upgrading).toContain("DROP TABLE IF EXISTS message_spam_training");
    expect(upgrading).toContain("DROP TABLE IF EXISTS inbox_spam_token_counts");
    expect(upgrading).toContain("DROP TABLE IF EXISTS inbox_spam_class_counts");
    expect(upgrading).toContain("DELETE FROM d1_migrations WHERE name = '0008_spam_learn.sql'");
    expect(readme).toContain("SPAM_LEARN");
    expect(readme).toContain("SPAM_LEARN_MIN");
    expect(readme).toContain("bayes_spam_0.97");
    expect(readme).toContain("messages training");
    expect(readme).toContain("Set `SPAM_LEARN` to `on`");
    expect(readme).toContain("messages training-backfill");
    expect(readme).toContain("backfill_spam_training");
    expect(upgrading).toContain("Apply 0007, then 0008, then deploy, then backfill.");
    expect(upgrading).toContain("messages training-backfill");
    const example = readFileSync("packages/worker/wrangler.jsonc.example", "utf8");
    expect(example).toContain('"SPAM_LEARN": "off"');
    expect(example).toContain('Set it to "on"');
  });
});

function statements(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("--"))
    .join("\n");
}
