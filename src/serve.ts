// Runs the MCP server over stdio (how VoiceOS launches a folder integration)
// or, with --http, as a local Streamable HTTP endpoint for VoiceOS builds that
// add apps by "MCP server URL" instead of from a folder.
//
//   bun server.ts                stdio
//   bun server.ts --http [port]  http://localhost:<port>/mcp
//
// HTTP mode listens on 127.0.0.1 only and rejects requests whose Host or
// Origin isn't localhost, so a web page can't reach it (DNS rebinding).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export async function serve(build: () => McpServer, name: string, defaultPort: number) {
  const i = process.argv.indexOf("--http");
  if (i < 0) {
    await build().connect(new StdioServerTransport());
    return;
  }
  const arg = Number(process.argv[i + 1]);
  const port = Number.isInteger(arg) && arg > 0 ? arg : Number(process.env.PORT ?? defaultPort);
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const origins = hosts.map((h) => `http://${h}`);

  Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 255, // track_ride can wait several minutes
    async fetch(req) {
      const res = await handle(req);
      if (process.env.MCP_LOG !== "0") {
        const t = new Date().toLocaleTimeString();
        let what = "";
        if (req.method === "POST") {
          try {
            const body = await req.clone().json();
            const msgs = Array.isArray(body) ? body : [body];
            what = msgs
              .map((m: any) => (m.method === "tools/call" ? `tools/call ${m.params?.name} ${JSON.stringify(m.params?.arguments ?? {})}` : m.method ?? "response"))
              .join(", ");
          } catch {
            what = "(unreadable body)";
          }
        }
        console.error(`${t}  ${req.method} ${new URL(req.url).pathname} ${what} -> ${res.status}`);
      }
      return res;
    },
  });
  console.error(`${name}: MCP server ready at http://localhost:${port}/mcp  (Ctrl+C to stop)`);

  async function handle(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ ok: true, name });
      if (url.pathname !== "/mcp") return new Response("Not found. The MCP endpoint is /mcp", { status: 404 });
      // No server-initiated messages, so decline the standalone SSE stream (allowed by the MCP spec).
      // Without an idle stream to drop, restarting the server doesn't make the client give up reconnecting.
      if (req.method === "GET" || req.method === "DELETE") {
        return new Response(null, { status: 405, headers: { Allow: "POST" } });
      }
      const origin = req.headers.get("origin");
      if (origin && !origins.includes(origin)) return new Response("Forbidden origin", { status: 403 });
      // Stateless: a fresh protocol session per request; app state lives in the shared backend.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: hosts,
        allowedOrigins: origins,
      });
      const server = build();
      await server.connect(transport);
      return transport.handleRequest(req.clone());
  }
}
