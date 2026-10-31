import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentPostOfficeClient } from "../packages/client/src/index.js";
import {
  FILESYSTEM_TOOL_NAMES,
  MCP_MAX_INLINE_ATTACHMENT_BYTES,
  MCP_MAX_TOOL_OUTPUT_BYTES,
  MCP_SCOPES,
  output,
  sharedTools,
} from "../packages/mcp/src/catalog.js";
import { createAgentPostOfficeMcpServer } from "../packages/mcp/src/server.js";
import { ALL_SCOPES } from "../packages/worker/src/types.js";

describe("Agent Post Office MCP contract", () => {
  it("exposes bounded API operations and keeps HTML opt-in", async () => {
    const getMessage = vi.fn(async () => ({ id: "msg_1", attachments: [], text: "plain", untrusted_content: true }));
    const fakeClient = {
      listInboxes: vi.fn(async () => []),
      getMessage,
    } as unknown as AgentPostOfficeClient;
    const server = createAgentPostOfficeMcpServer(fakeClient);
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "poll_messages",
      "get_message",
      "send_message",
      "reply_to_message",
      "save_raw_message",
      "save_attachment",
      "delete_message",
      "delete_messages",
    ]));
    await client.callTool({ name: "get_message", arguments: { message_id: "msg_1" } });
    expect(getMessage).toHaveBeenCalledWith("msg_1");

    await client.close();
    await server.close();
  });

  it("forwards thread and archive filters when polling", async () => {
    const listMessages = vi.fn(async () => ({ data: [], next_cursor: null }));
    const fakeClient = { listMessages } as unknown as AgentPostOfficeClient;
    const server = createAgentPostOfficeMcpServer(fakeClient);
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({
      name: "poll_messages",
      arguments: { thread_id: "msg_thread_root", archived: "false", replied: "false", state: "unprocessed" },
    });
    expect(result.isError).not.toBe(true);
    expect(listMessages).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "msg_thread_root",
      archived: false,
      replied: false,
      state: "unprocessed",
    }));
    await client.close();
    await server.close();
  });

  it("archives through messages:update without sending processed state", async () => {
    const updateMessage = vi.fn(async () => ({ id: "msg_1", archived_at: "2026-07-11T00:00:00.000Z" }));
    const fakeClient = { updateMessage } as unknown as AgentPostOfficeClient;
    const server = createAgentPostOfficeMcpServer(fakeClient);
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({
      name: "set_message_archived",
      arguments: { message_id: "msg_1", archived: true },
    });
    expect(result.isError).not.toBe(true);
    expect(updateMessage).toHaveBeenCalledWith("msg_1", { archived: true });
    await client.close();
    await server.close();
  });

  it("rejects an absolute download path outside the configured directory", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "agentpostoffice-mcp-"));
    const downloadDirectory = join(temporary, "downloads");
    const outsidePath = join(temporary, "outside.eml");
    const fakeClient = {
      downloadRaw: vi.fn(async () => new Response("hostile raw message")),
    } as unknown as AgentPostOfficeClient;
    const server = createAgentPostOfficeMcpServer(fakeClient, { downloadDirectory });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.callTool({
        name: "save_raw_message",
        arguments: { message_id: "msg_1", output_path: outsidePath, confirmed: true },
      });
      expect(result.isError).toBe(true);
      expect(fakeClient.downloadRaw).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("requires explicit confirmation before saving untrusted bytes", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "agentpostoffice-mcp-"));
    const outputPath = join(temporary, "unconfirmed.eml");
    const fakeClient = {
      downloadRaw: vi.fn(async () => new Response("hostile raw message")),
    } as unknown as AgentPostOfficeClient;
    const server = createAgentPostOfficeMcpServer(fakeClient, { downloadDirectory: temporary });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.callTool({
        name: "save_raw_message",
        arguments: { message_id: "msg_1", output_path: outputPath },
      });
      expect(result.isError).toBe(true);
      expect(fakeClient.downloadRaw).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("saves confirmed downloads as create-only files inside the configured directory", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "agentpostoffice-mcp-"));
    const downloadDirectory = join(temporary, "downloads");
    const outsidePath = join(temporary, "outside.bin");
    const checksum = createHash("sha256").update("attachment bytes").digest("hex");
    const fakeClient = {
      getMessage: vi.fn(async () => ({
        attachments: [{ id: "att_1", size: 16, checksum_sha256: checksum }],
      })),
      downloadAttachment: vi.fn(async () => new Response("attachment bytes", {
        headers: { "Content-Length": "16" },
      })),
    } as unknown as AgentPostOfficeClient;
    const server = createAgentPostOfficeMcpServer(fakeClient, { downloadDirectory });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const saved = await client.callTool({
        name: "save_attachment",
        arguments: {
          message_id: "msg_1",
          attachment_id: "att_1",
          output_path: "attachment.bin",
          confirmed: true,
        },
      });
      expect(saved.isError).not.toBe(true);
      expect(await readFile(join(downloadDirectory, "attachment.bin"), "utf8")).toBe("attachment bytes");
      expect((await stat(downloadDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(downloadDirectory, "attachment.bin"))).mode & 0o777).toBe(0o600);

      const duplicate = await client.callTool({
        name: "save_attachment",
        arguments: {
          message_id: "msg_1",
          attachment_id: "att_1",
          output_path: "attachment.bin",
          confirmed: true,
        },
      });
      expect(duplicate.isError).toBe(true);
      expect(await readFile(join(downloadDirectory, "attachment.bin"), "utf8")).toBe("attachment bytes");

      const traversal = await client.callTool({
        name: "save_attachment",
        arguments: {
          message_id: "msg_1",
          attachment_id: "att_1",
          output_path: "nested/escape.bin",
          confirmed: true,
        },
      });
      expect(traversal.isError).toBe(true);

      await writeFile(outsidePath, "outside", { mode: 0o600 });
      await symlink(outsidePath, join(downloadDirectory, "linked.bin"));
      const symlinkWrite = await client.callTool({
        name: "save_attachment",
        arguments: {
          message_id: "msg_1",
          attachment_id: "att_1",
          output_path: "linked.bin",
          confirmed: true,
        },
      });
      expect(symlinkWrite.isError).toBe(true);
      expect(await readFile(outsidePath, "utf8")).toBe("outside");
    } finally {
      await client.close();
      await server.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("rejects attachment bytes that do not match stored metadata", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "agentpostoffice-mcp-"));
    const expectedChecksum = createHash("sha256").update("attachment bytes").digest("hex");
    const fakeClient = {
      getMessage: vi.fn(async () => ({
        attachments: [{ id: "att_1", size: 16, checksum_sha256: expectedChecksum }],
      })),
      downloadAttachment: vi.fn(async () => new Response("ATTACHMENT BYTES", {
        headers: { "Content-Length": "16" },
      })),
    } as unknown as AgentPostOfficeClient;
    const server = createAgentPostOfficeMcpServer(fakeClient, { downloadDirectory: temporary });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.callTool({
        name: "save_attachment",
        arguments: {
          message_id: "msg_1",
          attachment_id: "att_1",
          output_path: "corrupt.bin",
          confirmed: true,
        },
      });
      expect(result.isError).toBe(true);
      await expect(readFile(join(temporary, "corrupt.bin"))).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("rejects missing attachment metadata before downloading", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "agentpostoffice-mcp-"));
    const fakeClient = {
      getMessage: vi.fn(async () => ({ attachments: [] })),
      downloadAttachment: vi.fn(async () => new Response("attachment bytes")),
    } as unknown as AgentPostOfficeClient;
    const server = createAgentPostOfficeMcpServer(fakeClient, { downloadDirectory: temporary });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.callTool({
        name: "save_attachment",
        arguments: {
          message_id: "msg_1",
          attachment_id: "att_missing",
          output_path: "missing.bin",
          confirmed: true,
        },
      });
      expect(result.isError).toBe(true);
      expect(fakeClient.downloadAttachment).not.toHaveBeenCalled();
      await expect(readFile(join(temporary, "missing.bin"))).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("rejects attachment bytes with a stored-size mismatch", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "agentpostoffice-mcp-"));
    const checksum = createHash("sha256").update("attachment bytes").digest("hex");
    const fakeClient = {
      getMessage: vi.fn(async () => ({
        attachments: [{ id: "att_1", size: 15, checksum_sha256: checksum }],
      })),
      downloadAttachment: vi.fn(async () => new Response("attachment bytes")),
    } as unknown as AgentPostOfficeClient;
    const server = createAgentPostOfficeMcpServer(fakeClient, { downloadDirectory: temporary });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.callTool({
        name: "save_attachment",
        arguments: {
          message_id: "msg_1",
          attachment_id: "att_1",
          output_path: "wrong-size.bin",
          confirmed: true,
        },
      });
      expect(result.isError).toBe(true);
      await expect(readFile(join(temporary, "wrong-size.bin"))).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("returns a checksum-verified base64 attachment under the inline cap", async () => {
    const bytes = "attachment bytes";
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const downloadAttachment = vi.fn(async () => new Response(bytes, { headers: { "Content-Length": String(bytes.length) } }));
    const fakeClient = {
      getMessage: vi.fn(async () => ({
        attachments: [{
          id: "att_1",
          filename: "note.txt",
          media_type: "text/plain",
          disposition: "attachment",
          size: bytes.length,
          checksum_sha256: checksum,
        }],
      })),
      downloadAttachment,
    } as unknown as AgentPostOfficeClient;
    const server = createAgentPostOfficeMcpServer(fakeClient);
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const saved = await client.callTool({
        name: "get_attachment",
        arguments: { message_id: "msg_1", attachment_id: "att_1", acknowledge_untrusted_bytes: true },
      });
      expect(saved.isError).not.toBe(true);
      const payload = JSON.parse((saved.content[0] as { text: string }).text) as {
        untrusted_content: boolean;
        data: { data_base64: string; checksum_sha256: string };
      };
      expect(payload.untrusted_content).toBe(true);
      expect(payload.data.checksum_sha256).toBe(checksum);
      expect(Buffer.from(payload.data.data_base64, "base64").toString("utf8")).toBe(bytes);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses an inline attachment above the cap before downloading", async () => {
    const downloadAttachment = vi.fn(async () => new Response("nope"));
    const fakeClient = {
      getMessage: vi.fn(async () => ({
        attachments: [{
          id: "att_big",
          filename: "big.bin",
          media_type: "application/octet-stream",
          disposition: "attachment",
          size: MCP_MAX_INLINE_ATTACHMENT_BYTES + 1,
          checksum_sha256: "a".repeat(64),
        }],
      })),
      downloadAttachment,
    } as unknown as AgentPostOfficeClient;
    const server = createAgentPostOfficeMcpServer(fakeClient);
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "get_attachment",
        arguments: { message_id: "msg_1", attachment_id: "att_big", acknowledge_untrusted_bytes: true },
      });
      expect(result.isError).toBe(true);
      expect(downloadAttachment).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("shared MCP catalog", () => {
  it("uses the REST scope list and the same tools on stdio and HTTP except filesystem saves", async () => {
    expect([...MCP_SCOPES]).toEqual([...ALL_SCOPES]);
    const fakeClient = {} as AgentPostOfficeClient;
    const server = createAgentPostOfficeMcpServer(fakeClient);
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = (await client.listTools()).tools.map((tool) => tool.name).sort();
      const httpNames = sharedTools.map((tool) => tool.name).sort();
      const filesystem = [...FILESYSTEM_TOOL_NAMES].sort();
      expect(listed.filter((name) => !filesystem.includes(name as typeof filesystem[number]))).toEqual(httpNames);
      expect(listed.filter((name) => filesystem.includes(name as typeof filesystem[number]))).toEqual(filesystem);
      expect(httpNames).not.toEqual(expect.arrayContaining(filesystem));
      expect(httpNames).toContain("get_attachment");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("requires confirmation for delete and Sieve changes, and not for send or reply", () => {
    const schemaOf = (name: string) => sharedTools.find((tool) => tool.name === name)?.inputSchema;
    expect(schemaOf("delete_message")).toHaveProperty("confirmed");
    expect(schemaOf("delete_messages")).toHaveProperty("confirmed");
    expect(schemaOf("activate_sieve_revision")).toHaveProperty("confirmed");
    expect(schemaOf("disable_sieve")).toHaveProperty("confirmed");
    expect(schemaOf("send_message")).not.toHaveProperty("confirmed");
    expect(schemaOf("reply_to_message")).not.toHaveProperty("confirmed");
  });

  it("bounds tool output without echoing the oversized payload", () => {
    const huge = "x".repeat(MCP_MAX_TOOL_OUTPUT_BYTES);
    const result = output(huge);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("output_too_large");
    expect(result.content[0]?.text).not.toContain(huge.slice(0, 64));
    expect(MCP_MAX_INLINE_ATTACHMENT_BYTES).toBeLessThan(MCP_MAX_TOOL_OUTPUT_BYTES);
  });

  it("documents the per-instance remote MCP URL and bearer header", async () => {
    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain("https://<your-worker>/mcp");
    expect(readme).toContain("Authorization");
    expect(readme).toContain("Bearer apo_<key-id>_<secret>");
  });
});
