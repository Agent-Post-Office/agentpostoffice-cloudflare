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
    ]);

    const column = statements("packages/worker/migrations/0005_message_archived.sql");
    expect(column).toBe("ALTER TABLE messages ADD COLUMN archived_at TEXT;");
    expect(column).not.toMatch(/\b(UPDATE|NOT NULL|DEFAULT)\b/i);

    const index = statements("packages/worker/migrations/0006_message_thread_feed.sql");
    expect(index).toMatch(/^CREATE INDEX messages_thread_feed_idx ON messages \(thread_id,.*received_at, id\);$/);
    expect(index).not.toMatch(/\b(UPDATE|ALTER TABLE|INDEXED BY)\b/i);
  });

  it("documents that archive routes need 0005 and the default feed does not", () => {
    const upgrading = readFileSync("docs/UPGRADING.md", "utf8");
    const readme = readFileSync("README.md", "utf8");
    expect(upgrading).toContain("0005_message_archived.sql");
    expect(upgrading).toContain("0006_message_thread_feed.sql");
    expect(upgrading).toMatch(/HTTP 500/);
    expect(upgrading).toContain("archived_at");
    expect(readme).toContain("thread_id");
    expect(readme).toContain("exact match");
    expect(readme).toContain("Archived messages stay in the default feed");
    expect(readme).toContain("--unanswered");
    expect(readme).toContain("--thread");
    expect(readme).toContain("--unarchived");
  });
});

function statements(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("--"))
    .join("\n");
}
