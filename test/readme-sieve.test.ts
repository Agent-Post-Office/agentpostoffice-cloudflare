import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("README Sieve feature documentation", () => {
  it("presents automatic replies as an opt-in bounded capability", async () => {
    const readme = await readFile("README.md", "utf8");

    expect(readme).toContain("Automatic plain-text replies");
    expect(readme).toContain("new inbound messages");
    expect(readme).toContain('vacation :days 7');
    expect(readme).toContain("No script is installed or activated by default");
    expect(readme).toContain("cannot inspect message bodies");
  });
});
