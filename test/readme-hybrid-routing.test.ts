import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("README hybrid Google Workspace routing", () => {
  it("documents coexistence without creating a same-domain forwarding loop", async () => {
    const readme = await readFile("README.md", "utf8");

    expect(readme).toContain("#### Keep one address in Google Workspace");
    expect(readme).toContain("domain.test-google-a.com");
    expect(readme).toContain("Do not forward the public address to itself");
    expect(readme).toContain("v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all");
    expect(readme).toContain("google._domainkey");
    expect(readme).toContain("catch-all Worker rule");
  });
});
