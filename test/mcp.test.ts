import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentPostOfficeClient } from "../packages/client/src/index.js";
import { createAgentPostOfficeMcpServer } from "../packages/mcp/src/server.js";

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
});
