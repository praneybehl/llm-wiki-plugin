# LLM Wiki server

This folder is the hosted backend for LLM Wiki. It is one Cloudflare Worker. Each wiki is one SQLite Durable Object. Markdown stays the source of truth.

Agents connect over MCP (`/mcp`) or the JSON API (`/api/v1`). People use the web pages at `/setup` and `/ui/<wiki>/`.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/praneybehl/llm-wiki-plugin/tree/main/server)

## Deploy with the button

1. Click **Deploy to Cloudflare** above.
2. Sign in to Cloudflare.
3. Enter a value for `ADMIN_TOKEN`. Use a long random value, for example the output of `openssl rand -base64 32`.
4. Keep the default resource names, or change them.
5. Click **Deploy**.
6. Open `https://<your-worker>.workers.dev/setup` when the deploy is complete.

The button creates the Durable Objects, the KV namespace, the R2 bucket, the Vectorize index and the Workers AI binding. You do not need to do a step after the deploy.

## Deploy from the command line

You need Node.js 22 or later and a Cloudflare account. The pinned Wrangler version needs Node.js 22.

```sh
cd server
npm ci
npx wrangler login
printf 'ADMIN_TOKEN=%s\n' "$(openssl rand -base64 32)" > .admin.env
cat .admin.env
npm run deploy -- --secrets-file .admin.env
rm .admin.env
```

Keep a copy of the `ADMIN_TOKEN` value in your password manager before you remove `.admin.env`.

`npm run deploy` creates the Vectorize index `llm-wiki` when it does not exist. Then it runs `wrangler deploy`. The first deploy of a new Worker must include the secret, because `wrangler.jsonc` marks `ADMIN_TOKEN` as required.

To change the secret later, run this command:

```sh
npx wrangler secret put ADMIN_TOKEN
```

A new secret signs out all web sessions. Agent tokens and OAuth grants stay valid.

## First run

1. Open `/setup` on your Worker address.
2. Sign in with `ADMIN_TOKEN`.
3. Click **Create wiki main and a first token**.
4. Copy the token. The server shows it one time only.
5. Put the token in the `LLM_WIKI_TOKEN` environment variable on the agent computer.
6. Copy the MCP configuration for your agent from the **Connect an agent** section.

The setup page has configuration for Claude Code, Codex, Cursor, Gemini CLI, OpenCode, omp and Pi, and generic MCP clients.

To move a local wiki to the server, use the command line client:

```sh
python3 skills/llm-wiki/scripts/wiki_remote.py login --url https://<your-worker>.workers.dev --token "$LLM_WIKI_TOKEN"
python3 skills/llm-wiki/scripts/wiki_remote.py import ~/wiki --dry-run
python3 skills/llm-wiki/scripts/wiki_remote.py import ~/wiki
```

## Endpoints

| Path | Use |
|---|---|
| `/mcp` | MCP over Streamable HTTP. Accepts the 2026-07-28 protocol and the earlier stateless protocol. |
| `/api/v1/...` | JSON API. The CLI and scripts use it. |
| `/setup` | Owner page: wikis, tokens, pairing codes, decision settings, agent configuration. |
| `/ui/<wiki>/` | Wiki browser with search, history, diffs and review flags. |
| `/authorize`, `/oauth/token`, `/oauth/register` | OAuth for MCP clients that sign in with a browser. |
| `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp` | OAuth discovery. |
| `/healthz` | Health check. Returns the server version. |

## Authentication

- **Agent tokens** have the form `lw_<wiki>_<secret>`. Send them as `Authorization: Bearer <token>`. Each token belongs to one wiki. Scopes are `read`, `write`, `raw:write` and `admin`. The `admin` scope includes all other scopes.
- **ADMIN_TOKEN** is the deployment owner secret. It can use every wiki. Select the wiki with the `X-LLM-Wiki` header or the `?wiki=` query parameter. The default wiki is `main`.
- **OAuth** is for MCP clients that open a browser. The owner approves each client with `ADMIN_TOKEN` or with a pairing code. A pairing code works one time, for 10 minutes, for one wiki. The owner selects read access or read and write access.

## Bindings

| Binding | Type | Required | Without it |
|---|---|---|---|
| `WIKI` | Durable Object (`WikiDO`) | Yes | |
| `REGISTRY` | Durable Object (`Registry`) | Yes | |
| `OAUTH_KV` | KV namespace | Yes | |
| `RAW` | R2 bucket | No | Raw file endpoints return 503. Raw files stay on the agent computer. |
| `VECTORIZE` | Vectorize index (384 dimensions, cosine) | No | Search uses only the lexical (BM25) leg. |
| `AI` | Workers AI | No | Search uses only the lexical leg. The `workers-ai` decision backend is not available. |
| `ADMIN_TOKEN` | Secret | Yes | Sign-in, setup and OAuth approval are not available. |
| `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `LIQUID_API_KEY` | Secrets | No | That decision backend is not available. |

## Free and Paid plans

The server works on the Workers Free plan. These limits apply:

- Each request gets a small CPU budget. The server keeps request work small. Embedding and graph rebuilds run later in Durable Object alarms, in batches.
- After a large import, search can be lexical for some pages for a short time. `wiki_overview` shows the number of sections that wait for vectors (`vector_lag`). After `vector_lag` reaches 0, Vectorize can need about one minute more before new sections match by meaning.
- Workers AI, Vectorize, R2 and Durable Objects have daily or monthly free amounts. A large wiki or many agents can use all of the free amount. Then features that need that product stop until the next period.
- A request body can be at most 100 MB. Raw files have the same limit.

On the Workers Paid plan, the CPU limit is higher and the free amounts are larger. Use the Paid plan for large wikis or many agents. See the Cloudflare pricing pages for current numbers.

## Limits

- One page: at most 1,500,000 bytes of UTF-8 text.
- One commit: at most 200 operations and 4 MB of content.
- One JSON request body: at most 5 MiB.
- One raw file: at most 100 MB.

## Security notes

- Use a long random `ADMIN_TOKEN`. Do not share it with agents. Give each agent its own token with the smallest scopes it needs.
- The server keeps only a SHA-256 hash of each agent token. Revoke a token on the setup page or with `DELETE /api/v1/admin/tokens/<id>`.
- Web sessions use a signed cookie. The signing key comes from `ADMIN_TOKEN`. Forms use CSRF tokens. Pages use a strict Content Security Policy.
- Page text shows as escaped text. The wiki browser does not run HTML or scripts from pages.
- Raw files cannot change after upload. A different file at the same path causes a conflict.
- Decision models are off by default. When you turn on a hosted backend, the server sends page text and queries to that provider.
- The OAuth consent page shows the client name, the redirect host and the requested scopes. Approve only clients that you started yourself.

## Development

```sh
npm ci
npm test
npx tsc --noEmit -p test
npx wrangler dev
```

`npm test` runs the tests in the Workers runtime with `wrangler.test.jsonc`. That configuration has no Vectorize index and no Workers AI binding.
