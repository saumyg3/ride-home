/**
 * Sign in to Uber once so Ride Home can book rides for you.
 *
 *   UBER_CLIENT_ID=... UBER_CLIENT_SECRET=... bun login.ts [sandbox|production]
 *
 * In your app on developer.uber.com, add this redirect URI:
 *   http://127.0.0.1:8789/callback
 *
 * Runs the standard OAuth authorization-code flow on localhost, then saves the
 * tokens to ~/.config/ride-home (readable only by you). Ride Home renews them
 * automatically. While your Uber app is in development, the `request` scope
 * works for your own account (and any developers you add) without Uber's review.
 */
import { AUTHORIZE_URL, SCOPES, saveTokens, TOKEN_URL, tokenPath, tokensFromResponse } from "./src/auth";

const env = (process.argv[2] ?? "sandbox").toLowerCase();
if (env !== "sandbox" && env !== "production") {
  console.error("Usage: bun login.ts [sandbox|production]");
  process.exit(1);
}
const clientId = process.env.UBER_CLIENT_ID;
const clientSecret = process.env.UBER_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set UBER_CLIENT_ID and UBER_CLIENT_SECRET (from your app at developer.uber.com) first.");
  process.exit(1);
}

const PORT = Number(process.env.RIDE_HOME_LOGIN_PORT ?? 8789);
const redirectUri = `http://127.0.0.1:${PORT}/callback`;
const state = crypto.randomUUID();

const authUrl = `${AUTHORIZE_URL}?${new URLSearchParams({
  client_id: clientId,
  response_type: "code",
  redirect_uri: redirectUri,
  scope: SCOPES.join(" "),
  state,
})}`;

const done = Promise.withResolvers<void>();

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
    const page = (msg: string, status = 200) =>
      new Response(`<!doctype html><meta charset="utf-8"><title>Ride Home</title><body style="font:16px system-ui;padding:40px">${msg}</body>`, {
        status,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });

    if (url.searchParams.get("state") !== state) return page("Sign-in failed: the state didn't match. Run <code>bun login</code> again.", 400);
    const error = url.searchParams.get("error");
    if (error) {
      done.reject(new Error(`Uber returned: ${error}`));
      return page(`Sign-in was not completed (${error}). You can close this tab.`, 400);
    }
    const code = url.searchParams.get("code");
    if (!code) return page("No authorization code in the response.", 400);

    try {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
          code,
        }).toString(),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error_description ?? json?.error ?? `HTTP ${res.status}`);
      const tokens = tokensFromResponse(json);
      await saveTokens(env, tokens);
      const missing = SCOPES.filter((s) => tokens.scope && !tokens.scope.split(" ").includes(s));
      if (missing.length) console.warn(`Warning: Uber didn't grant ${missing.join(", ")}. Booking needs the request scope.`);
      done.resolve();
      return page("Signed in to Uber. You can close this tab and go back to VoiceOS.");
    } catch (e) {
      done.reject(e as Error);
      return page(`Sign-in failed: ${(e as Error).message}`, 500);
    }
  },
});

console.log(`\nSign in to Uber (${env}) by opening:\n\n  ${authUrl}\n`);
const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
try {
  Bun.spawn([opener, authUrl], { stdout: "ignore", stderr: "ignore" });
} catch {
  /* user can open the link manually */
}

try {
  await Promise.race([done.promise, new Promise((_, rej) => setTimeout(() => rej(new Error("Timed out after 5 minutes.")), 300_000))]);
  console.log(`Signed in. Tokens saved to ${tokenPath(env)}`);
  console.log(`In VoiceOS, set this integration's Mode to ${env === "sandbox" ? "Sandbox" : "Production"}.`);
  server.stop();
  process.exit(0);
} catch (e) {
  console.error(`Sign-in failed: ${(e as Error).message}`);
  server.stop();
  process.exit(1);
}
