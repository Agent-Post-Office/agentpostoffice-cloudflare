export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly headers?: HeadersInit,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json(
      { error: { code: error.code, message: error.message } },
      error.status,
      error.headers,
    );
  }
  console.error("request_failed", error instanceof Error ? error.name : "unknown_error");
  return json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
}

export async function readJson<T>(request: Request, maxBytes = 65_536): Promise<T> {
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (declaredLength > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw new HttpError(413, "request_too_large", "Request body is too large");
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new HttpError(413, "request_too_large", "Request body is too large");
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
}

export function requireString(value: unknown, field: string, maximum = 10_000): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new HttpError(400, "invalid_request", `${field} must be a non-empty string`);
  }
  return value;
}
