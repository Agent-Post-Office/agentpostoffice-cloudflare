import { describe, expect, it, vi } from "vitest";
import { AgentPostOfficeClient, AgentPostOfficeError } from "../packages/client/src/index.js";

describe("AgentPostOfficeClient", () => {
  it("puts bearer credentials only in the Authorization header", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://inbox.example/v1/inboxes");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer apo_key_secret");
      expect(String(url)).not.toContain("apo_key_secret");
      return Response.json({ data: [] });
    });
    const client = new AgentPostOfficeClient({ baseUrl: "https://inbox.example/", token: "apo_key_secret", fetch: fetchMock as typeof fetch });
    await expect(client.listInboxes()).resolves.toEqual([]);
  });

  it("uses keyset filters and never invents offset pagination", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get("cursor")).toBe("opaque");
      expect(parsed.searchParams.get("offset")).toBeNull();
      expect(parsed.searchParams.get("state")).toBe("unprocessed");
      return Response.json({ data: [], next_cursor: null });
    });
    const client = new AgentPostOfficeClient({ baseUrl: "https://inbox.example", token: "secret", fetch: fetchMock as typeof fetch });
    await client.listMessages({ cursor: "opaque", state: "unprocessed" });
  });

  it("passes a replied filter independently of processed state", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return Response.json({ data: [], next_cursor: null });
    });
    const client = new AgentPostOfficeClient({ baseUrl: "https://inbox.example", token: "secret", fetch: fetchMock as typeof fetch });
    await client.listMessages({ replied: false, state: "unprocessed" });
    await client.listMessages({ replied: true });
    const unreplied = new URL(urls[0]!);
    expect(unreplied.searchParams.get("replied")).toBe("false");
    expect(unreplied.searchParams.get("state")).toBe("unprocessed");
    const replied = new URL(urls[1]!);
    expect(replied.searchParams.get("replied")).toBe("true");
    expect(replied.searchParams.get("state")).toBeNull();
  });

  it("passes thread and archive filters and patches the archive marker without state", async () => {
    const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method || "GET", body: typeof init?.body === "string" ? init.body : undefined });
      return Response.json({ data: { id: "msg_1" }, next_cursor: null });
    });
    const client = new AgentPostOfficeClient({ baseUrl: "https://inbox.example", token: "secret", fetch: fetchMock as typeof fetch });
    await client.listMessages({ threadId: "msg_thread_root", archived: false, replied: false, inboxId: "inb_home" });
    await client.updateMessage("msg_1", { archived: true });
    const listed = new URL(calls[0]!.url);
    expect(listed.searchParams.get("thread_id")).toBe("msg_thread_root");
    expect(listed.searchParams.get("archived")).toBe("false");
    expect(listed.searchParams.get("replied")).toBe("false");
    expect(listed.searchParams.get("inbox_id")).toBe("inb_home");
    expect(listed.searchParams.get("state")).toBeNull();
    expect(calls[1]).toEqual({
      url: "https://inbox.example/v1/messages/msg_1",
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
    });
  });

  it("requests HTML only when the caller opts in", async () => {
    const urls: string[] = [];
    const client = new AgentPostOfficeClient({
      baseUrl: "https://inbox.example",
      token: "secret",
      fetch: vi.fn(async (url: string | URL | Request) => {
        urls.push(String(url));
        return Response.json({ data: { id: "msg_1" } });
      }) as typeof fetch,
    });
    await client.getMessage("msg_1");
    await client.getMessage("msg_1", { includeHtml: true });
    expect(urls).toEqual([
      "https://inbox.example/v1/messages/msg_1",
      "https://inbox.example/v1/messages/msg_1?include_html=true",
    ]);
  });

  it("manages Sieve revisions through mailbox-scoped endpoints", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method || "GET" });
      if (String(url).endsWith("/activate")) return Response.json({ data: { id: "siv_1", active: true } });
      if (init?.method === "DELETE") return Response.json({ data: { active: false } });
      if (String(url).endsWith("/validate")) return Response.json({ data: { valid: true, profile: "agentpostoffice-autoresponder-v1" } });
      return Response.json({ data: { id: "siv_1", active: false } }, { status: 201 });
    });
    const client = new AgentPostOfficeClient({ baseUrl: "https://mail.example", token: "secret", fetch: fetchMock as typeof fetch });
    await client.validateSieve("inb_1", "require [\"vacation\"];");
    await client.createSieveRevision("inb_1", { name: "Welcome", source: "require [\"vacation\"];" });
    await client.activateSieve("inb_1", "siv_1");
    await client.disableSieve("inb_1");
    expect(calls).toEqual([
      { url: "https://mail.example/v1/inboxes/inb_1/sieve/validate", method: "POST" },
      { url: "https://mail.example/v1/inboxes/inb_1/sieve", method: "POST" },
      { url: "https://mail.example/v1/inboxes/inb_1/sieve/siv_1/activate", method: "POST" },
      { url: "https://mail.example/v1/inboxes/inb_1/sieve", method: "DELETE" },
    ]);
  });

  it("surfaces stable API errors without leaking the token", async () => {
    const client = new AgentPostOfficeClient({
      baseUrl: "https://inbox.example",
      token: "super-secret",
      fetch: vi.fn(async () => Response.json({ error: { code: "insufficient_scope", message: "Denied" } }, { status: 403 })) as typeof fetch,
    });
    await expect(client.listInboxes()).rejects.toMatchObject<Partial<AgentPostOfficeError>>({ status: 403, code: "insufficient_scope" });
    await expect(client.listInboxes()).rejects.not.toThrow(/super-secret/);
  });
});
