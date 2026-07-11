import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("agent-operated token administration", () => {
  it("has no npm token-management commands or token helper script", async () => {
    const packageDocument = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(Object.keys(packageDocument.scripts || {}).filter((name) => name.startsWith("token:"))).toEqual([]);
    await expect(access("tools/token.ts")).rejects.toThrow();
  });

  it("documents Wrangler D1 administration without putting the raw token in argv", async () => {
    const install = await readFile("docs/INSTALL.md", "utf8");
    const setupSkill = await readFile(".agents/skills/agentpostoffice-setup/SKILL.md", "utf8");
    const combined = `${install}\n${setupSkill}`;

    expect(combined).toContain("wrangler d1 execute");
    expect(combined).toContain("--token-stdin");
    expect(combined).not.toContain("npm run token:create");
    expect(combined).not.toContain("npm run token:list");
    expect(combined).not.toContain("npm run token:revoke");
  });
});
