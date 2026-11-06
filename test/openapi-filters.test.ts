import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const spec = parse(readFileSync("packages/openapi/spec/openapi.yaml", "utf8")) as {
  paths: Record<string, any>;
  components: { schemas: Record<string, any> };
};

describe("message list OpenAPI filters", () => {
  it("documents thread_id, archived, and the archive patch field", () => {
    const parameters = spec.paths["/messages"].get.parameters as Array<{ name?: string; description?: string }>;
    const thread = parameters.find((parameter) => parameter.name === "thread_id");
    const archived = parameters.find((parameter) => parameter.name === "archived");
    expect(thread?.description).toMatch(/exact match/i);
    expect(thread?.description).toMatch(/inbox/i);
    expect(archived?.description).toMatch(/not hidden by default|default feed/i);
    expect(spec.components.schemas.Message.properties).toHaveProperty("archived_at");
    const folder = parameters.find((parameter) => parameter.name === "folder");
    expect(folder?.description).toMatch(/spam folder stays out of the default feed/i);
    expect(spec.components.schemas.Message.properties).toHaveProperty("folder");
    expect(spec.components.schemas.Message.properties).toHaveProperty("spam");
    expect(spec.paths["/messages/{message_id}/mark-spam"].post["x-required-scopes"]).toEqual(["messages:update"]);
    expect(spec.paths["/messages/{message_id}/mark-spam"].post.description).toMatch(/inboxes:manage/);
    expect(spec.paths["/messages/{message_id}/mark-not-spam"].post.description).toMatch(/inboxes:manage/);
    const patch = spec.paths["/messages/{message_id}"].patch.requestBody.content["application/json"].schema.properties;
    expect(patch.archived).toMatchObject({ type: "boolean" });
    expect(JSON.stringify(patch.archived)).toMatch(/replied_at|processed/);
  });
});