import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const spec = parse(readFileSync("packages/openapi/spec/openapi.yaml", "utf8"));
const contract = [
  ["/inboxes", "get", "messages:read"], ["/inboxes", "post", "inboxes:manage"],
  ["/inboxes/{inbox_id}", "get", "messages:read"], ["/inboxes/{inbox_id}", "patch", "inboxes:manage"],
  ["/inboxes/{inbox_id}/sieve", "get", "sieve:read"],
  ["/inboxes/{inbox_id}/sieve", "post", "sieve:manage"],
  ["/inboxes/{inbox_id}/sieve", "delete", "sieve:manage"],
  ["/inboxes/{inbox_id}/sieve/validate", "post", "sieve:read"],
  ["/inboxes/{inbox_id}/sieve/{script_id}/activate", "post", "sieve:manage"],
  ["/inboxes/{inbox_id}/sieve/{script_id}/test", "post", "sieve:read"],
  ["/messages", "get", "messages:read"], ["/messages", "post", "messages:send"],
  ["/messages/bulk-delete", "post", "messages:delete"],
  ["/messages/{message_id}", "get", "messages:read"], ["/messages/{message_id}", "patch", "messages:update"],
  ["/messages/{message_id}", "delete", "messages:delete"],
  ["/messages/{message_id}/reply", "post", "messages:reply"],
  ["/messages/{message_id}/raw", "get", "messages:read"],
  ["/messages/{message_id}/attachments/{attachment_id}", "get", "messages:read"],
];

describe("canonical OpenAPI discovery", () => {
  it("serves an exact generated conversion of the canonical YAML", () => {
    expect(JSON.parse(readFileSync("packages/worker/src/openapi.generated.json", "utf8"))).toEqual(spec);
  });

  it("documents the protected route inventory and scope checks", () => {
    const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.entries(item as Record<string, any>).filter(([method, operation]) => ["get", "post", "patch", "delete"].includes(method) && !operation.security)
        .map(([method, operation]) => [path, method, operation["x-required-scopes"]?.[0]]));
    expect(operations.map((entry) => entry.join(" ")).sort()).toEqual(contract.map((entry) => entry.join(" ")).sort());
    const source = readFileSync("packages/worker/src/api.ts", "utf8");
    const matched = new Set<string>();
    let branchCount = 0;
    for (const functionName of ["routeInboxes", "routeMessages", "routeSieve"]) {
      const body = source.split(`async function ${functionName}(`)[1]!.split("\nasync function ")[0]!;
      const branches = [...body.matchAll(/if \(([^\n]+)\) \{\s*requireScope\(auth, "([^"]+)"\)/g)];
      branchCount += branches.length;
      for (const [path, method, scope] of contract.filter(([path]) => functionName === "routeSieve" ? path!.includes("/sieve") : path!.startsWith(functionName === "routeInboxes" ? "/inboxes" : "/messages") && !path!.includes("/sieve"))) {
        const segments = path!.split("/").filter(Boolean).slice(functionName === "routeSieve" ? 3 : 1).map((value) => value.startsWith("{") ? "placeholder" : value);
        const branch = branches.find((match) => matchesRoute(match[1]!, segments, method!.toUpperCase()));
        expect(branch, `${method} ${path}`).toBeDefined();
        expect(branch![2]).toBe(scope);
        matched.add(`${functionName}:${branch![1]}`);
      }
    }
    expect(matched.size).toBe(branchCount);
    // A changed predicate shape must be explicitly supported, rather than silently skipped.
    expect([...source.matchAll(/requireScope\(auth,/g)].length).toBe(branchCount);
    expect(source).toContain('if (segments[0] === "inboxes") return routeInboxes(');
    expect(source).toContain('if (segments[0] === "messages") return routeMessages(');
    for (const [path, method] of contract) {
      expect(spec.paths[path!][method!].responses["401"]).toBeDefined();
      expect(spec.paths[path!][method!].responses["403"]).toBeDefined();
    }
    for (const path of ["/messages", "/messages/{message_id}/reply"]) {
      const item = spec.paths[path];
      expect([...(item.parameters || []), ...(item.post.parameters || [])]).toContainEqual({ $ref: "#/components/parameters/IdempotencyKey" });
    }
  });
});

// Interpret only the handler's simple conjunctions; unknown syntax fails CI.
function matchesRoute(predicate: string, segments: string[], method: string): boolean {
  return predicate.split(" && ").every((term) => {
    if (term === "scriptId") return Boolean(segments[0]);
    if (term === "request.method === \"" + method + "\"") return true;
    if (/^request\.method === "[A-Z]+"$/.test(term)) return false;
    const length = /^segments\.length === (\d+)$/.exec(term);
    if (length) return segments.length === Number(length[1]);
    const segment = /^segments\[(\d+)\](?: === "([^"]+)")?$/.exec(term);
    if (segment) return segment[2] === undefined ? Boolean(segments[Number(segment[1])]) : segments[Number(segment[1])] === segment[2];
    throw new Error(`Unsupported route predicate: ${term}`);
  });
}
