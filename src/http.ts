import { USER_AGENT, apiUrl, requireApiKey } from "./config.js";
import type { GlobalOptions } from "./types.js";
import { HcaiError } from "./types.js";

export type RequestOptions = {
  method?: string;
  path: string;
  body?: unknown;
  auth?: boolean;
  headers?: Record<string, string>;
  /** Retry these HTTP statuses with exponential backoff (1s, 2s, 4s...). */
  retryStatuses?: number[];
  /** Total attempts when retrying. Defaults to 4. */
  maxAttempts?: number;
};

export async function request(options: GlobalOptions, requestOptions: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    ...requestOptions.headers,
  };

  let body: BodyInit | undefined;
  if (requestOptions.body !== undefined) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    body = typeof requestOptions.body === "string" ? requestOptions.body : JSON.stringify(requestOptions.body);
  }

  if (requestOptions.auth !== false) {
    headers.Authorization = `Bearer ${requireApiKey(options)}`;
  }

  const url = apiUrl(options, requestOptions.path);
  if (options.verbose) process.stderr.write(`> ${requestOptions.method || "GET"} ${url}\n`);

  const maxAttempts = requestOptions.retryStatuses?.length ? requestOptions.maxAttempts ?? 4 : 1;
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: requestOptions.method || "GET",
        headers,
        body,
        signal: AbortSignal.timeout(options.timeout * 1000),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
      throw new HcaiError(
        timedOut ? `Request timed out after ${options.timeout}s.` : `Network request failed: ${String(error)}`,
        timedOut ? 4 : 1,
        timedOut ? "Retry with a larger --timeout, especially for image or Replicate jobs." : undefined,
      );
    }

    if (options.verbose) process.stderr.write(`< ${response.status} ${response.statusText}\n`);
    if (response.ok) return response;
    if (attempt < maxAttempts && requestOptions.retryStatuses?.includes(response.status)) {
      const delay = 1000 * 2 ** (attempt - 1);
      if (options.verbose) process.stderr.write(`  retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxAttempts})\n`);
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    await throwApiError(response, url);
  }
}

export async function requestJson<T>(options: GlobalOptions, requestOptions: RequestOptions): Promise<T> {
  const response = await request(options, requestOptions);
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HcaiError(`API returned non-JSON response from ${requestOptions.path}.`, 1, text.slice(0, 500));
  }
}

export async function requestForm<T>(
  options: GlobalOptions,
  path: string,
  form: FormData,
): Promise<T> {
  const url = apiUrl(options, path);
  if (options.verbose) process.stderr.write(`> POST ${url}\n`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireApiKey(options)}`,
        "User-Agent": USER_AGENT,
      },
      body: form,
      signal: AbortSignal.timeout(options.timeout * 1000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    throw new HcaiError(
      timedOut ? `Request timed out after ${options.timeout}s.` : `Network request failed: ${String(error)}`,
      timedOut ? 4 : 1,
    );
  }

  if (options.verbose) process.stderr.write(`< ${response.status} ${response.statusText}\n`);
  if (!response.ok) await throwApiError(response, url);
  return (await response.json()) as T;
}

async function throwApiError(response: Response, url: string): Promise<never> {
  const text = await response.text();
  let message = text.trim();
  try {
    const parsed = JSON.parse(text) as {
      error?: unknown;
      message?: unknown;
      detail?: unknown;
    };
    const picked =
      (parsed.error as { message?: unknown } | undefined)?.message ?? parsed.error ?? parsed.message ?? parsed.detail;
    // Upstreams sometimes nest objects here (e.g. TypeSafe 529s); never print "[object Object]".
    if (picked !== undefined) message = typeof picked === "string" ? picked : JSON.stringify(picked);
  } catch {
    // Keep raw text.
  }

  const hint =
    response.status === 401
      ? "Check your Hack Club AI API key: hcai auth status"
      : response.status === 403
        ? "For Replicate, this can mean the model is not allowlisted or Replicate is not enabled for your account."
        : response.status === 429
          ? "Rate limit or daily spend limit hit. Check `hcai stats`, retry later, or reduce concurrency."
          : response.status === 503 || response.status === 529
            ? "Upstream is overloaded or unavailable. Retry in a bit."
            : undefined;

  throw new HcaiError(`HTTP ${response.status} from ${url}: ${message || response.statusText}`, response.status === 401 ? 3 : 1, hint);
}
