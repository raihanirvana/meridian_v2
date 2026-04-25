import { z } from "zod";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export class AdapterTransportError extends Error {
  public readonly adapterName: string;

  public constructor(adapterName: string, cause: unknown) {
    super(`${adapterName} transport error`);
    this.name = "AdapterTransportError";
    this.adapterName = adapterName;
    this.cause = cause;
  }
}

export class AdapterHttpStatusError extends Error {
  public readonly adapterName: string;
  public readonly status: number;
  public readonly responseText: string;

  public constructor(input: {
    adapterName: string;
    status: number;
    responseText: string;
  }) {
    const suffix =
      input.responseText.length > 0 ? `: ${input.responseText}` : "";
    super(`${input.adapterName} HTTP ${input.status}${suffix}`);
    this.name = "AdapterHttpStatusError";
    this.adapterName = input.adapterName;
    this.status = input.status;
    this.responseText = input.responseText;
  }
}

export class AdapterResponseValidationError extends Error {
  public readonly adapterName: string;
  public readonly details: string[];

  public constructor(adapterName: string, details: string[]) {
    super(
      `${adapterName} response validation failed${
        details.length > 0 ? `: ${details.join("; ")}` : ""
      }`,
    );
    this.name = "AdapterResponseValidationError";
    this.adapterName = adapterName;
    this.details = details;
  }
}

export interface JsonHttpClientOptions {
  adapterName: string;
  baseUrl: string;
  fetchFn?: FetchLike;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
}

export interface JsonHttpRequestOptions<T> {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
  responseSchema: z.ZodType<T>;
  timeoutMs?: number;
}

function buildUrl(input: {
  baseUrl: string;
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
}): string {
  const baseUrl = input.baseUrl.endsWith("/")
    ? input.baseUrl
    : `${input.baseUrl}/`;
  const relativePath = input.path.replace(/^\/+/, "");
  const url = new URL(relativePath, baseUrl);

  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value === null || value === undefined) {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

function summarizeText(input: string): string {
  return input.trim().slice(0, 200);
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${path}: ${issue.message}`;
  });
}

export class JsonHttpClient {
  private readonly adapterName: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number | null;

  public constructor(options: JsonHttpClientOptions) {
    this.adapterName = options.adapterName;
    this.baseUrl = z.url().parse(options.baseUrl);
    this.fetchFn = options.fetchFn ?? fetch;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? null;
  }

  public async request<T>(options: JsonHttpRequestOptions<T>): Promise<T> {
    const url = buildUrl({
      baseUrl: this.baseUrl,
      path: options.path,
      ...(options.query === undefined ? {} : { query: options.query }),
    });
    const resolvedTimeoutMs = options.timeoutMs ?? this.timeoutMs;
    const abortController =
      resolvedTimeoutMs === null ? null : new AbortController();
    let abortTimer: ReturnType<typeof setTimeout> | null = null;
    if (abortController !== null && resolvedTimeoutMs !== null) {
      abortTimer = setTimeout(() => {
        abortController.abort();
      }, resolvedTimeoutMs);
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: options.method,
        headers: {
          ...this.defaultHeaders,
          ...(options.body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...(options.headers ?? {}),
        },
        ...(abortController === null ? {} : { signal: abortController.signal }),
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      throw new AdapterTransportError(this.adapterName, error);
    } finally {
      if (abortTimer !== null) {
        clearTimeout(abortTimer);
      }
    }

    const text = await response.text();
    if (!response.ok) {
      throw new AdapterHttpStatusError({
        adapterName: this.adapterName,
        status: response.status,
        responseText: summarizeText(text),
      });
    }

    let parsedJson: unknown = null;
    if (text.trim().length > 0) {
      try {
        parsedJson = JSON.parse(text);
      } catch {
        throw new AdapterResponseValidationError(this.adapterName, [
          "response body is not valid JSON",
        ]);
      }
    }

    const parsed = options.responseSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new AdapterResponseValidationError(
        this.adapterName,
        formatZodIssues(parsed.error),
      );
    }

    return parsed.data;
  }
}
