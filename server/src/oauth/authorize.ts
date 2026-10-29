import { AuthorizationError, CimdFetchError, type AuthRequest, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import { isAdminToken, isWikiId, registryStub, wikiStub } from "../http/auth";
import { HttpError, escapeHtml as esc, readForm } from "../http/util";
import type { Scope } from "../types";
import { csrfField, htmlPage } from "../ui/layout";
import { checkCsrf, csrfFor, readSession } from "../ui/session";

/** OAuth scopes advertised by the authorization server. */
export const OAUTH_SCOPES = ["wiki:read", "wiki:write"] as const;

/** Props stored with every OAuth grant and handed to the MCP handler. */
export interface OAuthProps {
  wiki: string;
  label: string;
  scopes: Scope[];
}

/** Sources the consent form may redirect to after submission (CSP form-action). */
function redirectSource(redirectUri: string): string[] {
  try {
    const u = new URL(redirectUri);
    return u.protocol === "http:" || u.protocol === "https:" ? [u.origin] : [u.protocol];
  } catch {
    return [];
  }
}

interface FormState {
  error?: string;
  wiki?: string;
  access?: "read" | "write";
}

async function renderConsent(
  request: Request,
  env: Env,
  auth: AuthRequest,
  details: ConsentDescription,
  handle: string,
  extraHeaders: Headers,
  state: FormState,
  status = 200,
): Promise<Response> {
  const csrf = await csrfFor(request, env);
  if (!csrf) return plain(503, "The ADMIN_TOKEN secret is not set on this Worker.");
  const session = await readSession(request, env);
  const ownerSignedIn = !!session?.admin;
  const wikis = await registryStub(env).listWikis();
  const requested = details.scope.length ? details.scope : ["wiki:read"];
  const wantsWrite = state.access ? state.access === "write" : requested.includes("wiki:write");
  const name = esc(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${esc(details.clientDomain)}</strong>.`
    : "This app registered itself. Its name is not verified.";
  const options = wikis
    .map((w) => `<option value="${esc(w.id)}"${w.id === (state.wiki ?? "main") ? " selected" : ""}>${esc(w.id)}</option>`)
    .join("");
  const proof = ownerSignedIn
    ? '<p class="success">You are signed in as the owner. No token is needed.</p>'
    : `<label for="proof">Admin token or pairing code</label>
<input id="proof" name="proof" type="password" autocomplete="off" required>
<p class="muted">Use the ADMIN_TOKEN secret, or a pairing code from the setup page for the selected wiki.</p>`;
  const body = `<h1>Allow ${name} to use your wiki?</h1>
${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ""}
<div class="card">
<p>${origin}</p>
<p>Access goes to <strong>${esc(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p class="notice"><strong>This sends access to an app on your computer.</strong> Continue only if you started the sign-in from that app.</p>' : ""}
<p>Requested scopes: ${requested.map((s) => `<code>${esc(s)}</code>`).join(" ")}</p>
</div>
${
  wikis.length === 0
    ? '<p class="error" role="alert">This deployment has no wiki yet. Create one on the <a href="/setup">setup page</a> first.</p>'
    : `<form method="post" class="card">
${csrfField(csrf.token)}
<input type="hidden" name="handle" value="${esc(handle)}">
<label for="wiki">Wiki</label>
<select id="wiki" name="wiki">${options}</select>
<fieldset><legend>Access</legend>
<label class="inline"><input type="radio" name="access" value="read"${wantsWrite ? "" : " checked"}> Read</label>
<label class="inline"><input type="radio" name="access" value="write"${wantsWrite ? " checked" : ""}> Read and write</label>
</fieldset>
${proof}
<p class="row"><button type="submit" name="decision" value="approve">Allow</button>
<button class="secondary" type="submit" name="decision" value="deny" formnovalidate>Deny</button></p>
</form>`
}`;
  const headers = new Headers(extraHeaders);
  if (csrf.setCookie) headers.append("Set-Cookie", csrf.setCookie);
  return htmlPage({ title: `Authorize ${details.clientName}`, body, status, headers, formAction: redirectSource(auth.redirectUri) });
}

function plain(status: number, message: string): Response {
  return htmlPage({ title: "Authorization", status, body: `<h1>Authorization failed</h1><p class="error" role="alert">${esc(message)}</p>` });
}

function authError(e: unknown): Response {
  if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
  if (e instanceof AuthorizationError) return plain(400, e.description || "The authorization request is not valid. Start again from your app.");
  if (e instanceof CimdFetchError) return plain(400, "This app could not be verified.");
  throw e;
}

/** GET and POST `/authorize`: the consent page for MCP OAuth clients. */
export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) return plain(503, "OAuth is not available on this address.");
  if (request.method === "GET") {
    try {
      const auth = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(auth);
      const consent = await oauth.beginConsent(auth);
      return await renderConsent(request, env, auth, details, consent.handle, consent.headers, {});
    } catch (e) {
      return authError(e);
    }
  }
  if (request.method !== "POST") return plain(405, "Use GET or POST.");

  let form: FormData;
  try {
    form = await readForm(request);
  } catch (e) {
    if (e instanceof HttpError) return plain(e.status, e.status === 413 ? "The form is too large." : e.message);
    throw e;
  }
  const field = (n: string) => {
    const v = form.get(n);
    return typeof v === "string" ? v : "";
  };
  if (!(await checkCsrf(request, env, field("csrf")))) return plain(403, "The form token is not valid. Start again from your app.");
  const handle = field("handle");
  try {
    if (field("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const wiki = field("wiki");
    const access: "read" | "write" = field("access") === "read" ? "read" : "write";
    // The form posts to the authorization URL, so the request can be described again for a retry.
    const retry = async (error: string, status: number) => {
      const auth = await oauth.parseAuthRequest(new Request(request.url, { headers: request.headers }));
      const details = await oauth.describeConsent(auth);
      return renderConsent(request, env, auth, details, handle, new Headers(), { error, wiki, access }, status);
    };
    if (!isWikiId(wiki) || !(await registryStub(env).hasWiki(wiki))) return await retry("Select an existing wiki.", 400);

    let label = "oauth";
    let scopes: Scope[] = access === "write" ? ["read", "write"] : ["read"];
    const session = await readSession(request, env);
    const proof = field("proof").trim();
    if (session?.admin || (proof && (await isAdminToken(env, proof)))) {
      // The owner approves any access level.
    } else if (proof) {
      const code = await wikiStub(env, wiki).consumePairingCode(proof);
      if (!code) return await retry("The admin token or pairing code is not valid for this wiki.", 401);
      label = code.label;
      const codeAdmin = code.scopes.includes("admin");
      if (!codeAdmin && !code.scopes.includes("read")) return await retry("This pairing code does not grant read access.", 403);
      // The approved access is at most what the code grants.
      if (!codeAdmin && !code.scopes.includes("write")) scopes = ["read"];
    } else {
      return await retry("Enter the admin token or a pairing code.", 401);
    }

    const oauthScopes = scopes.includes("write") ? ["wiki:read", "wiki:write"] : ["wiki:read"];
    const approved = await oauth.approveConsent(request, handle, { scope: oauthScopes });
    const details = await oauth.describeConsent(approved.request);
    if (label === "oauth") label = `oauth:${details.clientName}`.slice(0, 100);
    const props: OAuthProps = { wiki, label, scopes };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: `wiki.${wiki}`,
      metadata: { wiki, label },
      scope: oauthScopes,
      props,
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    return authError(e);
  }
}
