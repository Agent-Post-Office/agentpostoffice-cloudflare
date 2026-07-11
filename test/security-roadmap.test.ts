import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("security roadmap operations guidance", () => {
  it("documents the accepted abuse-cost risk and Cloudflare alert setup", async () => {
    const readme = await readFile("README.md", "utf8");

    expect(readme).toContain("## Security roadmap and cost watch");
    expect(readme).toContain("APO-SEC-005");
    expect(readme).toContain("Manage Account > Billing > Billable Usage");
    expect(readme).toContain("Notifications > Add > Billable Usage");
    expect(readme).toContain("https://developers.cloudflare.com/billing/manage/budget-alerts/");
    expect(readme).toContain("do not pause, cap, or stop usage");
  });
});
