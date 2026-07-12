export const ALL_SCOPES = [
  "messages:read",
  "messages:update",
  "messages:reply",
  "messages:send",
  "messages:delete",
  "inboxes:manage",
  "sieve:read",
  "sieve:manage",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

export interface SendEmailResult {
  messageId: string;
}

export interface SendEmailBinding {
  send(message: {
    to: string;
    from: string | { email: string; name?: string };
    subject: string;
    text?: string;
    html?: string;
    replyTo?: string;
    headers?: Record<string, string>;
  }): Promise<SendEmailResult>;
}

export interface Env {
  DB: D1Database;
  MAIL_BUCKET: R2Bucket;
  MAIL_QUEUE: Queue<QueueTask>;
  AUTOMATION_QUEUE: Queue<QueueTask>;
  EMAIL: SendEmailBinding;
  MAIL_DOMAIN: string;
  MAX_INBOUND_BYTES?: string;
  BODY_EXCERPT_BYTES?: string;
  DLQ_NAME?: string;
  AUTOMATION_DLQ_NAME?: string;
}

export type QueueTask =
  | { kind: "parse"; messageId: string; rawR2Key: string }
  | { kind: "automate"; messageId: string; scriptId: string; scriptRevision: number }
  | { kind: "delete"; messageId: string };

export interface AuthContext {
  keyId: string;
  scopes: Scope[];
}

export interface InboxRow {
  id: string;
  domain: string;
  local_part: string;
  display_name: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  inbox_id: string;
  direction: "inbound" | "outbound";
  envelope_from: string;
  envelope_to: string;
  reply_to: string | null;
  subject: string | null;
  text_excerpt: string | null;
  body_truncated: number;
  raw_r2_key: string | null;
  parsed_r2_key: string | null;
  parse_status: "pending" | "ready" | "parse_failed" | "not_applicable";
  agent_state: "unprocessed" | "processed";
  labels_json: string;
  headers_json: string;
  outbound_status: "pending" | "accepted" | "failed" | "unknown" | null;
  cloudflare_message_id: string | null;
  received_at: string;
  sent_at: string | null;
  tombstoned_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttachmentRow {
  id: string;
  message_id: string;
  r2_key: string;
  filename: string | null;
  media_type: string;
  disposition: string;
  size: number;
  checksum_sha256: string;
  created_at: string;
}
