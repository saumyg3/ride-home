// Uber sign-in tokens.
//
// VoiceOS's manifest has an oauth2 auth kind, but the brokered login flow
// hasn't shipped yet, so for now `bun login.ts` runs the OAuth code flow once
// and saves tokens here. Access tokens last 30 days; the refresh token (from
// the offline_access scope) renews them without asking again.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AuthRequired, type Fetcher, type TokenProvider } from "./uber";

export const TOKEN_URL = "https://auth.uber.com/oauth/v2/token";
export const AUTHORIZE_URL = "https://auth.uber.com/oauth/v2/authorize";
export const SCOPES = ["profile", "places", "request", "offline_access"];

export type StoredTokens = { access_token: string; refresh_token?: string; expires_at: number; scope?: string };

export const configDir = () => process.env.RIDE_HOME_CONFIG_DIR ?? join(homedir(), ".config", "ride-home");
export const tokenPath = (env: string) => join(configDir(), `tokens-${env}.json`);

export async function saveTokens(env: string, t: StoredTokens): Promise<void> {
  const path = tokenPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(t, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path); // atomic, so a crash can't leave half a token file
}

export async function loadTokens(env: string): Promise<StoredTokens | null> {
  try {
    return JSON.parse(await readFile(tokenPath(env), "utf8"));
  } catch {
    return null;
  }
}

export function tokensFromResponse(json: any, now = Date.now()): StoredTokens {
  if (!json?.access_token) throw new AuthRequired("Uber didn't return an access token.");
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: now + Number(json.expires_in ?? 2_592_000) * 1000,
    scope: json.scope,
  };
}

/** Reads saved tokens and renews them with the refresh token when they expire or get rejected. */
export class FileTokenProvider implements TokenProvider {
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly env: string,
    private readonly clientId: string | undefined,
    private readonly clientSecret: string | undefined,
    private readonly fetcher: Fetcher = (u, i) => fetch(u, i),
  ) {}

  async get(): Promise<string> {
    const t = await loadTokens(this.env);
    if (!t) throw new AuthRequired(`You're not signed in to Uber (${this.env}). Run \`bun login\` in the ride-home folder.`);
    // Renew a minute early rather than send a token that expires mid-request.
    if (t.expires_at - 60_000 < Date.now() && t.refresh_token) return this.refresh();
    return t.access_token;
  }

  /** Single-flight, so parallel 401s trigger one refresh. */
  refresh(): Promise<string> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(): Promise<string> {
    const t = await loadTokens(this.env);
    if (!t?.refresh_token || !this.clientId || !this.clientSecret) {
      throw new AuthRequired("Your Uber sign-in expired. Run `bun login` in the ride-home folder to sign in again.");
    }
    let res: Response;
    try {
      res = await this.fetcher(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          grant_type: "refresh_token",
          refresh_token: t.refresh_token,
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new AuthRequired(`Couldn't renew your Uber sign-in: ${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new AuthRequired("Uber wouldn't renew your sign-in (it may have been revoked). Run `bun login` to sign in again.");
    }
    const next = tokensFromResponse(await res.json());
    next.refresh_token ??= t.refresh_token;
    await saveTokens(this.env, next);
    return next.access_token;
  }
}

/** For a token pasted directly (e.g. from the Uber dashboard). Can't be renewed. */
export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}
  async get() {
    return this.token;
  }
  async refresh(): Promise<string> {
    throw new AuthRequired("The Uber access token was rejected. Run `bun login` to sign in properly.");
  }
}
