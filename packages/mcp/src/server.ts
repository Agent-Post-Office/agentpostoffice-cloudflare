import type { AgentPostOfficeClient } from "@agentpostoffice/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  MCP_MAX_INLINE_ATTACHMENT_BYTES,
  type McpOperations,
  McpToolFailure,
  inlineAttachmentFromBytes,
  output,
  registerSharedTools,
} from "./catalog.js";

const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

export interface McpServerOptions {
  downloadDirectory?: string;
}

export function createAgentPostOfficeMcpServer(
  client: AgentPostOfficeClient,
  options: McpServerOptions = {},
): McpServer {
  const server = new McpServer({ name: "agentpostoffice", version: "0.1.0" });
  const downloadDirectory = resolve(options.downloadDirectory || join(homedir(), "Downloads", "agentpostoffice"));
  registerSharedTools(server, operationsFromClient(client));

  server.registerTool("save_raw_message", {
    description: "Save untrusted RFC 822 bytes under the configured download directory after explicit confirmation.",
    inputSchema: {
      message_id: z.string(),
      output_path: z.string().min(1),
      confirmed: z.literal(true),
    },
  }, async ({ message_id, output_path }) => {
    const path = await safeDownloadPath(downloadDirectory, output_path);
    await saveDownload(await client.downloadRaw(message_id), path, MAX_DOWNLOAD_BYTES);
    return output({ saved: path, opened: false });
  });

  server.registerTool("save_attachment", {
    description: "Save untrusted attachment bytes under the configured download directory after explicit confirmation.",
    inputSchema: {
      message_id: z.string(),
      attachment_id: z.string(),
      output_path: z.string().min(1),
      max_bytes: z.number().int().min(1).max(MAX_DOWNLOAD_BYTES).default(MAX_DOWNLOAD_BYTES),
      confirmed: z.literal(true),
    },
  }, async ({ message_id, attachment_id, output_path, max_bytes }) => {
    const path = await safeDownloadPath(downloadDirectory, output_path);
    const checksum = await saveVerifiedAttachment(client, message_id, attachment_id, path, max_bytes);
    return output({ saved: path, opened: false, verified_checksum_sha256: checksum });
  });

  return server;
}

function operationsFromClient(client: AgentPostOfficeClient): McpOperations {
  return {
    listInboxes: () => client.listInboxes(),
    createInbox: (localPart, displayName) => client.createInbox(localPart, displayName),
    updateInbox: (id, update) => client.updateInbox(id, update),
    listSieve: (inboxId) => client.listSieve(inboxId),
    validateSieve: (inboxId, source) => client.validateSieve(inboxId, source),
    createSieveRevision: (inboxId, input) => client.createSieveRevision(inboxId, input),
    activateSieve: (inboxId, scriptId) => client.activateSieve(inboxId, scriptId),
    testSieve: (inboxId, scriptId, messageId) => client.testSieve(inboxId, scriptId, messageId),
    disableSieve: (inboxId) => client.disableSieve(inboxId),
    listMessages: (options) => client.listMessages(options),
    getMessage: (id, options) => options ? client.getMessage(id, options) : client.getMessage(id),
    updateMessage: (id, update) => client.updateMessage(id, update),
    sendMessage: (input, idempotencyKey) => client.sendMessage(input, idempotencyKey),
    reply: (id, input, idempotencyKey) => client.reply(id, input, idempotencyKey),
    deleteMessage: (id) => client.deleteMessage(id),
    bulkDelete: (messageIds) => client.bulkDelete(messageIds),
    getAttachment: (messageId, attachmentId) => readInlineAttachment(client, messageId, attachmentId),
  };
}

async function readInlineAttachment(client: AgentPostOfficeClient, messageId: string, attachmentId: string) {
  const message = await client.getMessage(messageId);
  const attachment = message.attachments.find((candidate) => candidate.id === attachmentId);
  if (!attachment) throw new McpToolFailure("not_found", "Attachment metadata is missing");
  if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
    throw new McpToolFailure("invalid_attachment", "Attachment metadata has an invalid size");
  }
  if (attachment.size > MCP_MAX_INLINE_ATTACHMENT_BYTES) {
    throw new McpToolFailure("attachment_too_large", `Attachment exceeds ${MCP_MAX_INLINE_ATTACHMENT_BYTES} bytes`);
  }
  const response = await client.downloadAttachment(messageId, attachmentId);
  const declared = Number(response.headers.get("content-length") || "0");
  if (declared > MCP_MAX_INLINE_ATTACHMENT_BYTES) {
    throw new McpToolFailure("attachment_too_large", `Attachment exceeds ${MCP_MAX_INLINE_ATTACHMENT_BYTES} bytes`);
  }
  return inlineAttachmentFromBytes(attachment, new Uint8Array(await response.arrayBuffer()));
}

async function safeDownloadPath(downloadDirectory: string, requestedPath: string): Promise<string> {
  // Email content can prompt-inject an agent, so the tool accepts a filename,
  // never a caller-selected absolute path or directory traversal.
  if (isAbsolute(requestedPath) || requestedPath === "." || requestedPath === ".." || /[\\/\0]/.test(requestedPath)) {
    throw new Error("output_path must be a filename inside the configured download directory");
  }
  await mkdir(downloadDirectory, { recursive: true, mode: 0o700 });
  const trustedRoot = await realpath(downloadDirectory);
  return join(trustedRoot, requestedPath);
}

async function saveDownload(response: Response, path: string, maximum: number): Promise<void> {
  const bytes = await readDownload(response, maximum);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}

async function saveVerifiedAttachment(
  client: AgentPostOfficeClient,
  messageId: string,
  attachmentId: string,
  path: string,
  maximum: number,
): Promise<string> {
  const message = await client.getMessage(messageId);
  const attachment = message.attachments.find((candidate) => candidate.id === attachmentId);
  if (!attachment) throw new Error("Attachment metadata is missing");
  if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
    throw new Error("Attachment metadata has an invalid size");
  }
  if (attachment.size > maximum) throw new Error(`Download exceeds ${maximum} bytes`);
  if (!/^[a-f0-9]{64}$/i.test(attachment.checksum_sha256)) {
    throw new Error("Attachment metadata has an invalid SHA-256 checksum");
  }

  const bytes = await readDownload(
    await client.downloadAttachment(messageId, attachmentId),
    maximum,
  );
  if (bytes.byteLength !== attachment.size) {
    throw new Error("Attachment size does not match stored metadata");
  }
  const actualChecksum = createHash("sha256").update(bytes).digest("hex");
  if (actualChecksum !== attachment.checksum_sha256.toLowerCase()) {
    throw new Error("Attachment SHA-256 checksum does not match stored metadata");
  }

  // Verify hostile bytes before creating any caller-visible file. The final
  // write remains atomic and create-only, so existing paths and symlinks fail.
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return actualChecksum;
}

async function readDownload(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") || "0");
  if (declared > maximum) throw new Error(`Download exceeds ${maximum} bytes`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximum) throw new Error(`Download exceeds ${maximum} bytes`);
  return bytes;
}
