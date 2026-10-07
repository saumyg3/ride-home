// Uber Riders API v1.2 client.
//
// The rule this file enforces: reads and estimates are retried, ride creation
// never is. A POST /requests that times out or 5xx's might have booked a car,
// so it surfaces as AmbiguousWrite and the caller reconciles by checking for
// the ride instead of trying again.

import type { Env, UberProduct, UberRide } from "./types";

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export const BASE_URL: Record<Exclude<Env, "demo">, string> = {
  sandbox: "https://sandbox-api.uber.com",
  production: "https://api.uber.com",
};

/** Uber answered with an error. `code` is Uber's error code, e.g. "fare_expired". */
export class UberError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: any,
  ) {
    super(message);
  }
}

/** Couldn't reach Uber, or it failed after retries. Nothing is known to have changed. */
export class UberUnavailable extends Error {}

/** A write may or may not have happened (timeout, dropped connection, 5xx). */
export class AmbiguousWrite extends Error {}

/** Sign-in is missing or can't be refreshed. */
export class AuthRequired extends Error {}

export interface TokenProvider {
  get(): Promise<string>;
  /** Called after a 401. Returns a new token or throws AuthRequired. */
  refresh(): Promise<string>;
}

export type UberClientOptions = {
  baseUrl: string;
  tokens: TokenProvider;
  fetcher?: Fetcher;
  timeoutMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Uber returns errors in two shapes: {errors:[{status,code,title}]} and {code,message}. */
export function parseError(status: number, body: any): UberError {
  const e = body?.errors?.[0];
  const code = e?.code ?? body?.code ?? `http_${status}`;
  const message = e?.title ?? body?.message ?? `Uber returned HTTP ${status}`;
  return new UberError(status, code, message, body);
}

export class UberClient {
  private readonly fetcher: Fetcher;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(private readonly opts: UberClientOptions) {
    this.fetcher = opts.fetcher ?? ((u, i) => fetch(u, i));
    this.sleep = opts.sleep ?? realSleep;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = opts.retries ?? 2;
  }

  // ---------- endpoints ----------

  products(lat: number, lng: number): Promise<{ products: UberProduct[] }> {
    return this.call("GET", `/v1.2/products?latitude=${lat}&longitude=${lng}`, undefined, true);
  }

  /** Upfront fare (or a surge estimate). No side effects, so safe to retry. */
  estimate(body: Record<string, unknown>): Promise<any> {
    return this.call("POST", "/v1.2/requests/estimate", body, true);
  }

  /** Books a ride. Never retried here; see AmbiguousWrite. */
  createRequest(body: Record<string, unknown>): Promise<UberRide> {
    return this.call("POST", "/v1.2/requests", body, false);
  }

  /** The rider's active ride, or null when there isn't one. */
  async current(): Promise<UberRide | null> {
    try {
      return await this.call("GET", "/v1.2/requests/current", undefined, true);
    } catch (e) {
      if (e instanceof UberError && e.status === 404) return null;
      throw e;
    }
  }

  ride(requestId: string): Promise<UberRide> {
    return this.call("GET", `/v1.2/requests/${encodeURIComponent(requestId)}`, undefined, true);
  }

  /** Cancelling twice is harmless (the second returns 404/409), so it's retried. */
  cancel(requestId: string): Promise<void> {
    return this.call("DELETE", `/v1.2/requests/${encodeURIComponent(requestId)}`, undefined, true);
  }

  /** Uber's saved "home" / "work". Null when the rider hasn't set it. */
  async place(id: "home" | "work"): Promise<{ address: string } | null> {
    try {
      return await this.call("GET", `/v1.2/places/${id}`, undefined, true);
    } catch (e) {
      if (e instanceof UberError && e.status === 404) return null;
      throw e;
    }
  }

  // ---------- transport ----------

  private async call(method: string, path: string, body: unknown, retryable: boolean): Promise<any> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.opts.tokens.get();
      let res: Response;
      try {
        res = await this.fetcher(this.opts.baseUrl + path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Accept-Language": "en_US",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // Timeout or connection failure: we don't know if Uber acted on it.
        if (!retryable) throw new AmbiguousWrite(`No response from Uber: ${(err as Error).message}`);
        if (attempt < this.retries) {
          await this.sleep(backoff(attempt));
          continue;
        }
        throw new UberUnavailable(`Couldn't reach Uber: ${(err as Error).message}`);
      }

      // A 401 is rejected before any work is done, so retrying after refresh is safe even for writes.
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.opts.tokens.refresh();
        attempt--;
        continue;
      }
      if (res.status === 401) throw new AuthRequired("Uber rejected the sign-in. Run `bun login` again.");

      if (res.status === 204) return undefined;
      const text = await res.text();
      let data: any = undefined;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = { message: text.slice(0, 200) };
      }
      if (res.ok) return data;

      const transient = res.status === 429 || res.status >= 500;
      if (transient && !retryable) {
        // A 5xx on a write doesn't prove nothing happened.
        if (res.status >= 500) throw new AmbiguousWrite(`Uber returned ${res.status} while booking`);
        throw parseError(res.status, data); // 429 is a clean rejection
      }
      if (transient && attempt < this.retries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 3000) : backoff(attempt));
        continue;
      }
      if (transient) throw new UberUnavailable(`Uber is having trouble right now (HTTP ${res.status}).`);
      throw parseError(res.status, data);
    }
  }
}

function backoff(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 2000) + Math.floor(Math.random() * 100);
}
