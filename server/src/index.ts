import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { API_PREFIX, handleApi } from "./http/api";
import { bearerToken, principalFromBearer } from "./http/auth";
import { HttpError, errorResponse, fromHttpError, json } from "./http/util";
import { serveMcp } from "./mcp/server";
import { OAUTH_SCOPES, handleAuthorize, type OAuthProps } from "./oauth/authorize";
import { handleUi } from "./ui/routes";
import { SERVER_VERSION, type Principal, type Scope } from "./types";

export { WikiDO } from "./do/wiki";
export { Registry } from "./do/registry";

/** Props the MCP handler receives: an OAuth grant, or a resolved external bearer token. */
type McpProps = OAuthProps | { external: true; principal: Principal };

/** Local scope each OAuth scope grants. */
const OAUTH_SCOPE_MAP: Record<string, Scope> = { "wiki:read": "read", "wiki:write": "write" };

/**
 * An OAuth principal holds the grant's scopes that the presented token also
 * carries: a token narrowed at exchange or refresh keeps only its own scopes.
 */
function principalFromProps(props: McpProps, tokenScopes: readonly string[]): Principal {
  if ("external" in props) return props.principal;
  const effective = new Set(tokenScopes.map((s) => OAUTH_SCOPE_MAP[s]).filter((s): s is Scope => !!s));
  // OAuth grants carry read and at most write; never admin.
  const scopes = props.scopes.filter((s): s is Scope => (s === "read" || s === "write") && effective.has(s));
  return { wiki: props.wiki, label: props.label, scopes, deploymentAdmin: false };
}

const mcpApiHandler = {
  async fetch(request, env, ctx) {
    const c = ctx as ExecutionContext & { props?: McpProps; auth?: { scope?: string[] } };
    if (!c.props) return errorResponse(401, "unauthorized", "Missing credentials.");
    return serveMcp(request, env, principalFromProps(c.props, c.auth?.scope ?? []));
  },
} satisfies ExportedHandler<Env>;

/** Everything outside `/mcp`: API, UI, the consent page and health checks. */
async function defaultFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/healthz") return json({ ok: true, version: SERVER_VERSION });
  if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) return handleApi(request, env);
  if (path === "/authorize") return handleAuthorize(request, env);
  const ui = await handleUi(request, env);
  if (ui) return ui;
  return errorResponse(404, "not_found", "Not found.");
}

const defaultHandler: ExportedHandler<Env> = { fetch: (request, env) => defaultFetch(request, env) };

/**
 * The OAuth resource URL is `<origin>/mcp`, taken from the request, so a
 * deployment needs no configuration. One provider is built per origin.
 */
const providers = new Map<string, OAuthProvider<Env> | null>();

function providerFor(origin: string): OAuthProvider<Env> | null {
  if (providers.has(origin)) return providers.get(origin)!;
  const resource = `${origin}/mcp`;
  let provider: OAuthProvider<Env> | null;
  try {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpApiHandler,
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: [...OAUTH_SCOPES],
      requiredScopes: ["wiki:read"],
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: { resource, authorization_servers: [origin], resource_name: "LLM Wiki" },
      async resolveExternalToken({ token, request, env }) {
        let principal: Principal | null;
        try {
          principal = await principalFromBearer(env, token, request);
        } catch (e) {
          if (e instanceof HttpError) return null;
          throw e;
        }
        return principal ? { props: { external: true, principal } satisfies McpProps, audience: resource } : null;
      },
    });
  } catch (e) {
    // Plain http on a non-loopback host cannot carry OAuth. Bearer tokens still work.
    console.warn(`OAuth disabled for ${origin}: ${e instanceof Error ? e.message : String(e)}`);
    provider = null;
  }
  if (providers.size > 16) providers.clear();
  providers.set(origin, provider);
  return provider;
}

/** Fallback without OAuth: `/mcp` accepts bearer tokens only. */
async function fetchWithoutOAuth(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path !== "/mcp" && !path.startsWith("/mcp/")) return defaultFetch(request, env);
  const token = bearerToken(request);
  try {
    const p = token ? await principalFromBearer(env, token, request) : null;
    if (!p) return errorResponse(401, "unauthorized", "Send a bearer token in the Authorization header.");
    return serveMcp(request, env, p);
  } catch (e) {
    if (e instanceof HttpError) return fromHttpError(e);
    throw e;
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    const provider = providerFor(new URL(request.url).origin);
    return provider ? provider.fetch(request, env, ctx) : fetchWithoutOAuth(request, env);
  },
} satisfies ExportedHandler<Env>;
