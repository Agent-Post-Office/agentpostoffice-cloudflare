import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  MCP_MAX_INLINE_ATTACHMENT_BYTES,
  McpToolFailure,
  type McpOperations,
  type McpScope,
  inlineAttachmentFromBytes,
  registerSharedTools,
} from "../../mcp/src/catalog.js";
import { authenticate, requireScope } from "./auth.js";
import { dispatchAuthorized, readAttachmentPayload } from "./api.js";
import { errorResponse, HttpError, json } from "./http.js";
import type { AuthContext, Env } from "./types.js";

// REST send/reply bodies are capped at 1_100_000 bytes. The extra room is the
// JSON-RPC envelope around that same payload.
export const MCP_MAX_REQUEST_BODY_BYTES = 1_200_000;

const SENSITIVE_HEADERS = ["authorization", "cookie", "proxy-authorization"];

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  // SDK 1.32 still opens a GET SSE stream when sessionIdGenerator is omitted.
  // This server is stateless, so those methods stop here.
  if (request.method !== "POST") {
    return json({ error: { code: "method_not_allowed", message: "Method not allowed" } }, 405, { Allow: "POST" });
  }

  // Same authenticate() path as /v1: one D1 lookup, no separate limiter, and no
  // browser CORS. Callers are processes that already hold the bearer header.
  let auth: AuthContext;
  try {
    auth = await authenticate(request, env);
  } catch (error) {
    return errorResponse(error);
  }

  let parsed: unknown;
  try {
    const body = await readBoundedMcpBody(request);
    if (body.tooLarge) {
      return jsonRpcError(413, -32000, `Payload Too Large: Request body must not exceed ${MCP_MAX_REQUEST_BODY_BYTES} bytes`);
    }
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return jsonRpcError(400, -32700, "Parse error: Invalid JSON");
    }
    // MCP 2025-06-18 dropped JSON-RPC batches. The SDK still accepts up to 100
    // messages, which would let one read key fan out into a huge tool result.
    if (Array.isArray(parsed)) {
      return jsonRpcError(400, -32600, "Invalid Request: JSON-RPC batches are not supported");
    }
  } catch (error) {
    console.error("mcp_request_failed", error instanceof Error ? error.name : "unknown_error");
    return errorResponse(new HttpError(500, "internal_error", "Internal server error"));
  }

  try {
    const server = new McpServer({ name: "agentpostoffice", version: "0.1.0" }, {
      // Tool arguments are checked with Zod. This stub avoids Ajv's code
      // generation, which Workers reject, on the elicitation path we do not use.
      jsonSchemaValidator: {
        getValidator() {
          return () => ({ valid: false, data: undefined, errorMessage: "JSON schema validation is not enabled" });
        },
      },
    });
    registerSharedTools(server, operationsFor(auth, env), {
      allows: (scope) => scopeAllowed(auth, scope),
      hideUnexpectedErrors: true,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES,
    });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(requestWithoutSecrets(request), { parsedBody: parsed });
      return withNoStore(response);
    } finally {
      await server.close();
    }
  } catch (error) {
    console.error("mcp_request_failed", error instanceof Error ? error.name : "unknown_error");
    return errorResponse(new HttpError(500, "internal_error", "Internal server error"));
  }
}

function scopeAllowed(auth: AuthContext, scope: McpScope): boolean {
  try {
    requireScope(auth, scope);
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.code === "insufficient_scope") return false;
    throw error;
  }
}

function operationsFor(auth: AuthContext, env: Env): McpOperations {
  return {
    listInboxes: async () => (await callApi(auth, env, "/v1/inboxes")).data,
    createInbox: async (localPart, displayName) => (await callApi(auth, env, "/v1/inboxes", {
      method: "POST",
      body: { local_part: localPart, ...(displayName ? { display_name: displayName } : {}) },
    })).data,
    updateInbox: async (id, update) => (await callApi(auth, env, `/v1/inboxes/${pathId(id)}`, {
      method: "PATCH",
      body: update,
    })).data,
    listSieve: async (inboxId) => (await callApi(auth, env, `/v1/inboxes/${pathId(inboxId)}/sieve`)).data,
    validateSieve: async (inboxId, source) => (await callApi(auth, env, `/v1/inboxes/${pathId(inboxId)}/sieve/validate`, {
      method: "POST",
      body: { source },
    })).data,
    createSieveRevision: async (inboxId, input) => (await callApi(auth, env, `/v1/inboxes/${pathId(inboxId)}/sieve`, {
      method: "POST",
      body: input,
    })).data,
    activateSieve: async (inboxId, scriptId) => (await callApi(
      auth,
      env,
      `/v1/inboxes/${pathId(inboxId)}/sieve/${pathId(scriptId)}/activate`,
      { method: "POST" },
    )).data,
    testSieve: async (inboxId, scriptId, messageId) => (await callApi(
      auth,
      env,
      `/v1/inboxes/${pathId(inboxId)}/sieve/${pathId(scriptId)}/test`,
      { method: "POST", body: { message_id: messageId } },
    )).data,
    disableSieve: async (inboxId) => (await callApi(auth, env, `/v1/inboxes/${pathId(inboxId)}/sieve`, {
      method: "DELETE",
    })).data,
    listMessages: async (options) => {
      const query = new URLSearchParams();
      if (options.inboxId) query.set("inbox_id", options.inboxId);
      if (options.state) query.set("state", options.state);
      if (options.direction) query.set("direction", options.direction);
      if (options.replied !== undefined) query.set("replied", options.replied ? "true" : "false");
      if (options.threadId) query.set("thread_id", options.threadId);
      if (options.archived !== undefined) query.set("archived", options.archived ? "true" : "false");
      if (options.order) query.set("order", options.order);
      if (options.limit) query.set("limit", String(options.limit));
      if (options.cursor) query.set("cursor", options.cursor);
      const suffix = query.size ? `?${query.toString()}` : "";
      return callApi(auth, env, `/v1/messages${suffix}`);
    },
    getMessage: async (id, options) => {
      const suffix = options?.includeHtml ? "?include_html=true" : "";
      const payload = await callApi(auth, env, `/v1/messages/${pathId(id)}${suffix}`);
      return payload.data as { attachments: unknown };
    },
    updateMessage: async (id, update) => (await callApi(auth, env, `/v1/messages/${pathId(id)}`, {
      method: "PATCH",
      body: update,
    })).data,
    sendMessage: async (input, idempotencyKey) => (await callApi(auth, env, "/v1/messages", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: input,
    })).data,
    reply: async (id, input, idempotencyKey) => (await callApi(auth, env, `/v1/messages/${pathId(id)}/reply`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: input,
    })).data,
    deleteMessage: async (id) => (await callApi(auth, env, `/v1/messages/${pathId(id)}`, {
      method: "DELETE",
    })).data,
    bulkDelete: async (messageIds) => (await callApi(auth, env, "/v1/messages/bulk-delete", {
      method: "POST",
      body: { message_ids: messageIds },
    })).data,
    getAttachment: async (messageId, attachmentId) => {
      try {
        pathId(messageId);
        pathId(attachmentId);
        const loaded = await readAttachmentPayload(messageId, attachmentId, env, MCP_MAX_INLINE_ATTACHMENT_BYTES);
        return await inlineAttachmentFromBytes(loaded, loaded.bytes);
      } catch (error) {
        if (error instanceof HttpError) throw new McpToolFailure(error.code, error.message);
        throw error;
      }
    },
  };
}

async function callApi(auth: AuthContext, env: Env, path: string, init: {
  method?: string;
  body?: unknown;
  headers?: HeadersInit;
} = {}): Promise<{ data?: unknown; next_cursor?: string | null; error?: { code?: string; message?: string } }> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const url = internalUrl(path);
  const response = await dispatchAuthorized(new Request(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }), auth, env);
  const payload = await response.json() as {
    data?: unknown;
    next_cursor?: string | null;
    error?: { code?: string; message?: string };
  };
  if (!response.ok) {
    throw new McpToolFailure(payload.error?.code || "request_failed", payload.error?.message || "Request failed");
  }
  return payload;
}

function pathId(id: string): string {
  if (hasDotSegmentId(id)) throw new McpToolFailure("invalid_request", "Invalid resource id");
  return encodeURIComponent(id);
}

function hasDotSegmentId(value: string): boolean {
  let current = value;
  for (let round = 0; round < 4; round += 1) {
    if (current.split(/[/\\]/).some((segment) => segment === "." || segment === "..")) return true;
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return /%(?:2e|2f|5c)/i.test(current);
    }
    if (decoded === current) return false;
    current = decoded;
  }
  return current.split(/[/\\]/).some((segment) => segment === "." || segment === "..");
}

function internalUrl(path: string): URL {
  const queryAt = path.indexOf("?");
  const intendedPathname = queryAt === -1 ? path : path.slice(0, queryAt);
  const url = new URL(path, "https://mcp.internal");
  if (url.origin !== "https://mcp.internal" || url.pathname !== intendedPathname) {
    throw new McpToolFailure("invalid_request", "Invalid resource id");
  }
  return url;
}

async function readBoundedMcpBody(request: Request): Promise<{ tooLarge: true } | { tooLarge: false; text: string }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MCP_MAX_REQUEST_BODY_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    return { tooLarge: true };
  }
  if (request.body === null) return { tooLarge: false, text: "" };
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MCP_MAX_REQUEST_BODY_BYTES) {
        try { reader.releaseLock(); } catch { /* cancel below owns the stream */ }
        await request.body?.cancel().catch(() => undefined);
        return { tooLarge: true };
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    try { reader.releaseLock(); } catch { /* released before cancel */ }
  }
  return { tooLarge: false, text: text + decoder.decode() };
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function requestWithoutSecrets(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of SENSITIVE_HEADERS) headers.delete(name);
  // The POST body was already consumed. The transport receives parsedBody instead.
  return new Request(request.url, { method: request.method, headers });
}

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
