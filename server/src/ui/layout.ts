import { escapeHtml } from "../http/util";
import { SERVER_VERSION } from "../types";

const CSS = `
:root{--bg:#fff;--fg:#1d1f23;--muted:#5b6170;--line:#d9dce3;--accent:#1f5fbf;--accent-fg:#fff;--soft:#f3f5f9;--warn:#8a4b00;--warn-bg:#fff4e0;--bad:#a1260d;--ok:#1d6b35;--code:#f3f5f9}
@media (prefers-color-scheme:dark){:root{--bg:#15171b;--fg:#e7e9ee;--muted:#a3a9b6;--line:#343842;--accent:#7fb0ff;--accent-fg:#0b1220;--soft:#1e2127;--warn:#ffcf8a;--warn-bg:#3a2a12;--bad:#ff8f7a;--ok:#7fd69a;--code:#1e2127}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
header.top{display:flex;gap:1rem;align-items:center;flex-wrap:wrap;padding:.6rem 1.2rem;border-bottom:1px solid var(--line)}
header.top .brand{font-weight:700;text-decoration:none;color:var(--fg)}
header.top nav{display:flex;gap:1rem;flex-wrap:wrap}
header.top form{margin:0 0 0 auto}
main{max-width:72rem;margin:0 auto;padding:1.2rem}
.skip{position:absolute;left:-999px}.skip:focus{left:1rem;top:1rem;background:var(--bg);padding:.4rem}
h1{font-size:1.6rem;margin:.2rem 0 1rem}h2{font-size:1.25rem;margin-top:2rem}
.muted{color:var(--muted)}
.card{border:1px solid var(--line);border-radius:8px;padding:1rem 1.2rem;margin:1rem 0;background:var(--bg)}
.notice{border-left:4px solid var(--warn);background:var(--warn-bg);padding:.6rem 1rem;border-radius:4px}
.error{border-left:4px solid var(--bad);padding:.6rem 1rem;background:var(--soft);border-radius:4px}
.success{border-left:4px solid var(--ok);padding:.6rem 1rem;background:var(--soft);border-radius:4px}
label{display:block;margin:.6rem 0 .2rem;font-weight:600}
label.inline{display:inline-flex;gap:.35rem;align-items:center;font-weight:400;margin-right:1rem}
input[type=text],input[type=password],input[type=search],input[type=number],select{font:inherit;padding:.45rem .6rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);min-width:16rem;max-width:100%}
button{font:inherit;padding:.45rem .9rem;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);cursor:pointer}
button.secondary{background:transparent;color:var(--accent)}
button.danger{border-color:var(--bad);background:transparent;color:var(--bad)}
table{border-collapse:collapse;width:100%;margin:.6rem 0}
th,td{border-bottom:1px solid var(--line);padding:.4rem .5rem;text-align:left;vertical-align:top}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
code{background:var(--code);padding:.05rem .3rem;border-radius:4px}
pre{background:var(--code);padding:.8rem;border-radius:6px;overflow:auto}
pre code{background:none;padding:0}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 16rem;gap:2rem}
@media (max-width:900px){.layout{grid-template-columns:1fr}}
aside nav ul{list-style:none;padding-left:0}aside nav li{margin:.2rem 0}
.tree ul{list-style:none;padding-left:1rem;margin:.2rem 0}.tree>ul{padding-left:0}
details>summary{cursor:pointer}
.diff .add{color:var(--ok)}.diff .del{color:var(--bad)}.diff .hunk{color:var(--muted)}
.token{word-break:break-all;font-size:1rem;padding:.6rem;display:block}
article.page{min-width:0}article.page img{max-width:100%}
.row{display:flex;gap:.6rem;align-items:end;flex-wrap:wrap}
.d2{margin-left:.8rem}.d3{margin-left:1.6rem}.d4{margin-left:2.4rem}.d5{margin-left:3.2rem}.d6{margin-left:4rem}
footer{max-width:72rem;margin:2rem auto;padding:0 1.2rem;color:var(--muted);font-size:.85rem}
`;

export interface PageOptions {
  title: string;
  body: string;
  status?: number;
  headers?: HeadersInit;
  /** Extra navigation for a wiki. */
  wiki?: string;
  signedIn?: boolean;
  csrf?: string;
  /** Extra form-action sources (the OAuth redirect target). */
  formAction?: string[];
}

export function htmlPage(o: PageOptions): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const formAction = ["'self'", ...(o.formAction ?? [])].join(" ");
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    "img-src 'self' data:",
    `form-action ${formAction}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const wikiNav = o.wiki
    ? `<a href="/ui/${esc(o.wiki)}/">Pages</a><a href="/ui/${esc(o.wiki)}/history">History</a><a href="/ui/${esc(o.wiki)}/review">Review</a>`
    : "";
  const signOut =
    o.signedIn && o.csrf
      ? `<form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><button class="secondary" type="submit">Sign out</button></form>`
      : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${esc(o.title)} · LLM Wiki</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
<a class="brand" href="/">LLM Wiki</a>
<nav aria-label="Main">${o.wiki ? `<span class="muted">${esc(o.wiki)}</span>` : ""}${wikiNav}<a href="/setup">Setup</a></nav>
${signOut}
</header>
<main id="main">
${o.body}
</main>
<footer>LLM Wiki server ${SERVER_VERSION}</footer>
</body>
</html>`;
  const headers = new Headers(o.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", csp);
  headers.set("X-Content-Type-Options", "nosniff");
  // "same-origin", not "no-referrer": with no-referrer, browsers send `Origin: null`
  // on form POSTs, and the CSRF origin check then rejects every form.
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Frame-Options", "DENY");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(html, { status: o.status ?? 200, headers });
}

function esc(v: unknown): string {
  return escapeHtml(String(v));
}

export function redirect(location: string, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("Location", location);
  h.set("Cache-Control", "no-store");
  return new Response(null, { status: 303, headers: h });
}

export function csrfField(token: string): string {
  return `<input type="hidden" name="csrf" value="${esc(token)}">`;
}
