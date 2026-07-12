export interface ClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

export interface Inbox {
  id: string;
  address: string;
  local_part: string;
  domain: string;
  display_name: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SieveScript {
  id: string;
  inbox_id: string;
  name: string;
  revision: number;
  source: string;
  source_sha256: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Attachment {
  id: string;
  filename: string | null;
  media_type: string;
  disposition: string;
  size: number;
  checksum_sha256: string;
}

export interface Message {
  id: string;
  inbox: { id: string; address?: string; display_name?: string | null };
  direction: "inbound" | "outbound";
  received_at: string;
  sent_at: string | null;
  from: { address: string };
  to: { address: string };
  subject: string | null;
  text: string;
  html?: string | null;
  body_truncated: boolean;
  attachments: Attachment[];
  state: "processed" | "unprocessed";
  labels: string[];
  parse_status: "pending" | "ready" | "parse_failed" | "not_applicable";
  outbound_status: "pending" | "accepted" | "failed" | "unknown" | null;
  cloudflare_message_id: string | null;
  untrusted_content: true;
  parsed?: unknown;
}

export interface ListMessageOptions {
  inboxId?: string;
  state?: "processed" | "unprocessed";
  direction?: "inbound" | "outbound";
  since?: string;
  until?: string;
  order?: "asc" | "desc";
  limit?: number;
  cursor?: string;
}

export class AgentPostOfficeError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export class AgentPostOfficeClient {
  readonly baseUrl: string;
  readonly token: string;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImplementation = options.fetch || globalThis.fetch;
    if (!/^https?:\/\//.test(this.baseUrl)) throw new Error("baseUrl must be an absolute HTTP(S) URL");
    if (!this.token) throw new Error("token is required");
  }

  async status(): Promise<{ ok: true; inbox_count: number }> {
    const inboxes = await this.listInboxes();
    return { ok: true, inbox_count: inboxes.length };
  }

  async listInboxes(): Promise<Inbox[]> {
    return (await this.request<{ data: Inbox[] }>("/v1/inboxes")).data;
  }

  async getInbox(id: string): Promise<Inbox> {
    return (await this.request<{ data: Inbox }>(`/v1/inboxes/${encodeURIComponent(id)}`)).data;
  }

  async createInbox(localPart: string, displayName?: string): Promise<Inbox> {
    return (await this.request<{ data: Inbox }>("/v1/inboxes", {
      method: "POST",
      body: JSON.stringify({ local_part: localPart, ...(displayName ? { display_name: displayName } : {}) }),
    })).data;
  }

  async updateInbox(id: string, update: { active?: boolean; display_name?: string | null }): Promise<Inbox> {
    return (await this.request<{ data: Inbox }>(`/v1/inboxes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(update),
    })).data;
  }

  async listSieve(inboxId: string): Promise<SieveScript[]> {
    return (await this.request<{ data: SieveScript[] }>(`/v1/inboxes/${encodeURIComponent(inboxId)}/sieve`)).data;
  }

  async validateSieve(inboxId: string, source: string): Promise<{ valid: true; profile: string }> {
    return (await this.request<{ data: { valid: true; profile: string } }>(`/v1/inboxes/${encodeURIComponent(inboxId)}/sieve/validate`, {
      method: "POST",
      body: JSON.stringify({ source }),
    })).data;
  }

  async createSieveRevision(inboxId: string, input: { name: string; source: string }): Promise<SieveScript> {
    return (await this.request<{ data: SieveScript }>(`/v1/inboxes/${encodeURIComponent(inboxId)}/sieve`, {
      method: "POST",
      body: JSON.stringify(input),
    })).data;
  }

  async activateSieve(inboxId: string, scriptId: string): Promise<SieveScript> {
    return (await this.request<{ data: SieveScript }>(`/v1/inboxes/${encodeURIComponent(inboxId)}/sieve/${encodeURIComponent(scriptId)}/activate`, {
      method: "POST",
    })).data;
  }

  async testSieve(inboxId: string, scriptId: string, messageId: string): Promise<{ plan: unknown | null }> {
    return (await this.request<{ data: { plan: unknown | null } }>(`/v1/inboxes/${encodeURIComponent(inboxId)}/sieve/${encodeURIComponent(scriptId)}/test`, {
      method: "POST",
      body: JSON.stringify({ message_id: messageId }),
    })).data;
  }

  async disableSieve(inboxId: string): Promise<{ active: false }> {
    return (await this.request<{ data: { active: false } }>(`/v1/inboxes/${encodeURIComponent(inboxId)}/sieve`, {
      method: "DELETE",
    })).data;
  }

  async listMessages(options: ListMessageOptions = {}): Promise<{ data: Message[]; next_cursor: string | null }> {
    const query = new URLSearchParams();
    if (options.inboxId) query.set("inbox_id", options.inboxId);
    if (options.state) query.set("state", options.state);
    if (options.direction) query.set("direction", options.direction);
    if (options.since) query.set("since", options.since);
    if (options.until) query.set("until", options.until);
    if (options.order) query.set("order", options.order);
    if (options.limit) query.set("limit", String(options.limit));
    if (options.cursor) query.set("cursor", options.cursor);
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request(`/v1/messages${suffix}`);
  }

  async getMessage(id: string, options: { includeHtml?: boolean } = {}): Promise<Message> {
    const suffix = options.includeHtml ? "?include_html=true" : "";
    return (await this.request<{ data: Message }>(`/v1/messages/${encodeURIComponent(id)}${suffix}`)).data;
  }

  async updateMessage(id: string, update: { state?: "processed" | "unprocessed"; labels?: string[] }): Promise<unknown> {
    return (await this.request<{ data: unknown }>(`/v1/messages/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(update),
    })).data;
  }

  async acknowledgeMessage(id: string): Promise<unknown> {
    return this.updateMessage(id, { state: "processed" });
  }

  async sendMessage(input: {
    inbox_id: string;
    to: string;
    subject: string;
    text?: string;
    html?: string;
    reply_to?: string;
  }, idempotencyKey: string = crypto.randomUUID()): Promise<unknown> {
    return (await this.request<{ data: unknown }>("/v1/messages", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input),
    })).data;
  }

  async reply(id: string, input: { text?: string; html?: string }, idempotencyKey: string = crypto.randomUUID()): Promise<unknown> {
    return (await this.request<{ data: unknown }>(`/v1/messages/${encodeURIComponent(id)}/reply`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input),
    })).data;
  }

  async deleteMessage(id: string): Promise<unknown> {
    return (await this.request<{ data: unknown }>(`/v1/messages/${encodeURIComponent(id)}`, { method: "DELETE" })).data;
  }

  async bulkDelete(messageIds: string[]): Promise<unknown> {
    return (await this.request<{ data: unknown }>("/v1/messages/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ message_ids: messageIds }),
    })).data;
  }

  async downloadRaw(id: string): Promise<Response> {
    return this.requestResponse(`/v1/messages/${encodeURIComponent(id)}/raw`);
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<Response> {
    return this.requestResponse(`/v1/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.requestResponse(path, init);
    return response.json() as Promise<T>;
  }

  private async requestResponse(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      throw new AgentPostOfficeError(
        response.status,
        payload?.error?.code || "request_failed",
        payload?.error?.message || `Agent Post Office request failed with HTTP ${response.status}`,
        payload,
      );
    }
    return response;
  }
}
