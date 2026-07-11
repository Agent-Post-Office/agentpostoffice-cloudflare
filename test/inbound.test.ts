import { describe, expect, it, vi } from "vitest";
import { handleInbound, type ForwardableEmailMessage } from "../packages/worker/src/inbound.js";
import type { Env } from "../packages/worker/src/types.js";

describe("inbound SMTP acceptance boundary", () => {
  it("permanently rejects unknown recipients before touching storage", async () => {
    const harness = inboundHarness({ inbox: null });
    await handleInbound(harness.message, harness.env);
    expect(harness.reject).toHaveBeenCalledWith("Unknown or disabled recipient");
    expect(harness.r2Put).not.toHaveBeenCalled();
    expect(harness.queueSend).not.toHaveBeenCalled();
  });

  it("rejects oversize mail before reading the raw stream", async () => {
    const harness = inboundHarness({ rawSize: 101, maxBytes: 100 });
    await handleInbound(harness.message, harness.env);
    expect(harness.reject).toHaveBeenCalledWith("Message exceeds the configured size limit");
    expect(harness.r2Put).not.toHaveBeenCalled();
  });

  it("persists R2, then D1, then Queue before returning SMTP success", async () => {
    const events: string[] = [];
    const harness = inboundHarness({ events });
    await handleInbound(harness.message, harness.env);
    expect(events).toEqual(["r2", "d1", "queue"]);
    expect(harness.reject).not.toHaveBeenCalled();
  });

  it("materializes the inbound stream to known-length bytes before R2 persistence", async () => {
    const harness = inboundHarness();
    await handleInbound(harness.message, harness.env);
    const storedBody = harness.r2Put.mock.calls[0]?.[1];
    expect(storedBody).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(storedBody as ArrayBuffer)).toBe("raw message");
  });

  it("lets infrastructure failure escape instead of falsely acknowledging SMTP", async () => {
    const harness = inboundHarness({ queueFailure: new Error("queue unavailable") });
    await expect(handleInbound(harness.message, harness.env)).rejects.toThrow("queue unavailable");
    expect(harness.r2Put).toHaveBeenCalledOnce();
    expect(harness.d1Run).toHaveBeenCalledOnce();
    expect(harness.reject).not.toHaveBeenCalled();
  });
});

function inboundHarness(options: {
  inbox?: Record<string, unknown> | null;
  rawSize?: number;
  maxBytes?: number;
  queueFailure?: Error;
  events?: string[];
} = {}) {
  const events = options.events || [];
  const reject = vi.fn();
  const r2Put = vi.fn(async () => { events.push("r2"); });
  const d1Run = vi.fn(async () => { events.push("d1"); return { success: true, meta: { changes: 1 } }; });
  const queueSend = vi.fn(async () => {
    events.push("queue");
    if (options.queueFailure) throw options.queueFailure;
  });
  const inbox = options.inbox === undefined ? {
    id: "inb_1", domain: "mail.example.com", local_part: "research", display_name: null,
    active: 1, created_at: "now", updated_at: "now",
  } : options.inbox;
  const statement = {
    bind: vi.fn(function () { return this; }),
    first: vi.fn(async () => inbox),
    run: d1Run,
  };
  const message: ForwardableEmailMessage = {
    from: "sender@example.net",
    to: "research@mail.example.com",
    headers: new Headers({ subject: "Hello" }),
    raw: new Blob(["raw message"]).stream(),
    rawSize: options.rawSize ?? 11,
    setReject: reject,
  };
  const env = {
    DB: { prepare: vi.fn(() => statement) },
    MAIL_BUCKET: { put: r2Put },
    MAIL_QUEUE: { send: queueSend },
    EMAIL: {},
    MAIL_DOMAIN: "mail.example.com",
    MAX_INBOUND_BYTES: String(options.maxBytes ?? 10 * 1024 * 1024),
  } as unknown as Env;
  return { env, message, reject, r2Put, d1Run, queueSend };
}
