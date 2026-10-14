<div align="center">

# LeafMCP

**A remote MCP server that lets AI assistants read and edit your Overleaf projects.**

Ask Gemini, Claude, or ChatGPT to tighten a paragraph, fix a broken `\cite`, or update a table —
and watch it happen in your actual Overleaf project, not in a chat window you then copy from.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue.svg)](https://modelcontextprotocol.io)
[![CI](https://github.com/CherryLemon/leafmcp/actions/workflows/ci.yml/badge.svg)](https://github.com/CherryLemon/leafmcp/actions/workflows/ci.yml)

</div>

---

## Table of contents

- [Why this exists](#why-this-exists)
- [Features](#features)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Deployment](#deployment)
- [Connecting clients](#connecting-clients)
- [Tools](#tools)
- [Configuration](#configuration)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Limitations](#limitations)
- [Acknowledgements](#acknowledgements)
- [License](#license)

---

## Why this exists

Overleaf has no public API for editing project files, and the AI assistants people actually pay
for do not expose an API at all. Three facts shaped this project:

**1. Overleaf cannot be embedded in another page.** `www.overleaf.com` sends
`X-Frame-Options: SAMEORIGIN`, so a single-page app with "real Overleaf on the left, chat on the
right" is not possible. LeafMCP takes the opposite approach: Overleaf stays open in your
browser as usual, and the assistant edits the same project through the server. Reload and the
change is there.

**2. A Gemini subscription is not API access.** Google AI Pro / Ultra are subscriptions to the
Gemini *app*; they do not include quota for `generativelanguage.googleapis.com`, which is billed
separately through AI Studio. "Use my subscription" therefore means *letting the web app call
tools*, which is exactly what MCP is for — rather than holding an API key ourselves.

**3. OAuth is the only thing all three clients agree on.** ChatGPT documents no way to send a
static API key to a custom MCP server; Gemini's custom-app flow is OAuth-only with no token
fallback; Claude supports static headers but only in a limited beta. So this server ships a real
OAuth 2.1 authorization server (dynamic client registration, PKCE, refresh rotation, RFC 9728 /
RFC 8414 discovery). It is not optional — without it the server simply does not connect.

## Features

- **22 LaTeX-aware tools** — read, search, edit, rename, compile, undo, and review comments.
- **Edits land in Overleaf within seconds.** Each accepted change is published immediately, so
  your browser shows it without a manual sync.
- **Every edit is versioned.** Each change is a git commit in a local mirror; `undo_last_edit`
  reverses recent edits with a real `git revert` and republishes.
- **Fresh reads.** A file is re-fetched from Overleaf before it is read or edited, so an edit
  fails loudly instead of silently overwriting something you changed in the browser.
- **Compile-and-check loop.** `compile` publishes pending edits first, then returns a distilled
  error/warning summary with line numbers — not a 4,000-line LaTeX log.
- **Review comments** are first-class: list them, act on them, reply, resolve.
- **One server, several assistants.** No per-client forks or special cases.
- **Read-only mode**, per-connection scopes, and OAuth the operator approves by hand.

## Architecture

```
┌────────────────┐   ┌────────────────┐   ┌────────────────┐
│ Gemini web app │   │ Claude /       │   │ Cursor /       │
│ (your plan)    │   │ ChatGPT        │   │ Claude Desktop │
└───────┬────────┘   └───────┬────────┘   └───────┬────────┘
        │  MCP over HTTPS + OAuth 2.1             │ stdio
        └────────────────────┼────────────────────┘
                             ▼
                 ┌───────────────────────┐
                 │   LeafMCP server      │  ← runs on your server + domain
                 │  · 22 LaTeX tools     │
                 │  · OAuth 2.1 AS       │
                 │  · git-versioned      │
                 │    project mirrors    │
                 └───────────┬───────────┘
                             │ Overleaf web session
                             ▼
                 ┌───────────────────────┐
                 │       Overleaf        │
                 └───────────────────────┘
```

Requests arrive from the **vendors' clouds**, not from your browser, so the server must be
reachable over public HTTPS. `localhost` will not work for the remote clients (it works fine for
the stdio transport).

## Quick start

### 1. Get your Overleaf session cookie

Sign in to Overleaf, open any project, then DevTools → **Application** → **Cookies** → copy the
value of `overleaf_session2`.

> On self-hosted Overleaf / ShareLaTeX the cookie is usually `sharelatex.sid`; set
> `OVERLEAF_COOKIE_NAME` accordingly.

This value is a full-account credential. It is held in process memory only, never written to
disk, and scrubbed from every log line and tool result.

### 2. Configure

```bash
git clone https://github.com/CherryLemon/leafmcp.git
cd leafmcp
cp .env.example .env
```

Fill in at minimum `OVERLEAF_SESSION`, `PUBLIC_URL`, `MCP_AUTH_MODE`, and `MCP_OAUTH_PASSWORD`.

```bash
openssl rand -base64 24   # generate the OAuth approval passphrase
```

### 3. Build and check

```bash
npm install
npm run build

node dist/index.js --check     # validate config, list every problem, start nothing
node dist/index.js --verify    # validate Overleaf credentials only, list your projects
node dist/index.js             # start the server
```

> **Debug in this order.** Run `--verify` first to confirm the Overleaf half works, *then*
> connect a client. From inside a chat window, a bad cookie and a broken MCP setup look
> identical.

### 4. Run the tests

```bash
npm test
```

## Deployment

Clients connect from their vendors' clouds, so the server needs a **public HTTPS** address.

```bash
cp .env.example .env
# PUBLIC_URL in .env must match MCP_DOMAIN exactly
MCP_DOMAIN=mcp.example.com docker compose -f docker/docker-compose.yml up -d
```

Caddy obtains and renews the certificate automatically. `docker/Caddyfile` disables response
buffering — a compile takes tens of seconds, and a buffered response looks like a hung server.

**DNS requirement:** the hostname needs an IPv4 `A` record. Claude rejects hosts that only have
AAAA records.

### Without Docker

Requires **Node 22+** and `git` on `PATH`:

```bash
npm ci && npm run build
PUBLIC_URL=https://mcp.example.com node dist/index.js
```

Put Nginx or Caddy in front for TLS.

## Connecting clients

The MCP endpoint is always:

```
https://your-domain/mcp
```

### Gemini web app

1. Open `gemini.google.com` in a desktop browser.
2. **Settings → Connected Apps → Custom apps → Add a custom app.**
3. Enter `https://your-domain/mcp`.
4. LeafMCP supports dynamic client registration, so you can skip *Advanced features → Show
   more* (that is only needed for servers without DCR).
5. Click **Next** and approve the OAuth consent screen by entering `MCP_OAUTH_PASSWORD`.
6. Mention the app with `@appname` in a prompt.

### Claude

1. `claude.ai` → **Customize → Connectors → Add → Custom → Web**.
2. Enter `https://your-domain/mcp`.
3. Approve the OAuth consent screen.

A free account can add one custom connector. Claude's callback
(`https://claude.ai/api/mcp/auth_callback`) is already allowlisted.

### ChatGPT

1. `chatgpt.com/plugins` → **"+" → Add custom MCP server** (older path: Settings → Connectors →
   Advanced → Developer mode).
2. Enter `https://your-domain/mcp`.
3. Approve the OAuth consent screen.

ChatGPT's callback (`https://chatgpt.com/connector_platform_oauth_redirect`) is already
allowlisted.

### Local clients (Cursor, Claude Desktop, MCP Inspector)

Use the stdio transport; no public address needed:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "node",
      "args": ["/absolute/path/to/leafmcp/dist/index.js", "--stdio"],
      "env": {
        "OVERLEAF_SESSION": "your cookie value",
        "OLMCP_DATA_DIR": "/absolute/path/to/leafmcp/data"
      }
    }
  }
}
```

### Verifying the connection

```bash
curl https://your-domain/healthz
curl https://your-domain/.well-known/oauth-protected-resource
```

## Tools

22 tools. Read tools carry `readOnlyHint`, mutating ones carry `destructiveHint`, and clients use
those hints to decide when to ask for confirmation.

### Projects

| Tool | Description |
|---|---|
| `list_projects` | List every project in the account. |
| `use_project` | Select the working project by id, exact name, or a unique substring. |
| `project_overview` | File tree, plus the section structure of the main document and any unpublished changes. |

### Files

| Tool | Description |
|---|---|
| `list_files` | List project files with sizes. |
| `read_file` | Read a file with line numbers; supports `start_line` / `end_line`. |
| `read_files` | Read several files in one call. |
| `search_project` | Search all text files by substring or regular expression. |
| `file_outline` | Sections, labels, citations, includes and environments of one `.tex` file. |
| `edit_file` | **Preferred.** Replace an exact snippet; ambiguous matches are refused. |
| `write_file` | Write a whole file, creating it if needed. |
| `delete_file` | Delete a file (requires explicit `confirm=true`). |
| `rename_file` | Rename or move a file. |
| `pending_changes` | List local edits not yet sent to Overleaf. |

### Build and history

| Tool | Description |
|---|---|
| `compile` | Compile on Overleaf; returns distilled errors/warnings and the PDF link. |
| `publish_changes` | Push pending local edits to Overleaf. |
| `pull_project` | Re-download the project from Overleaf. |
| `edit_history` | Recent changes made through this server. |
| `undo_last_edit` | **Reverse** the last N edits and republish. |

### Review comments

| Tool | Description |
|---|---|
| `list_comments` | List comment threads with file and line. |
| `add_comment` | Add a comment, optionally anchored to a line. |
| `reply_to_comment` | Reply within a thread. |
| `resolve_comment` | Mark a thread resolved. |

### Design notes

- **Mirror plus git.** Each project has a locally cached, git-versioned mirror. The ref
  `refs/overleaf/pushed` records what Overleaf already has, so "what would a push change?" is a
  `git diff` rather than bookkeeping we could get wrong.
- **Undo is real.** Every tool edit is a commit, and `undo_last_edit` uses `git revert`, so an
  undo is itself undoable. It deliberately refuses to reverse a *reload from Overleaf* — that
  would push a stale copy over whatever you changed in the browser.
- **Freshness before use.** A file is re-fetched from Overleaf before being read or edited
  (whenever nothing is unpublished locally). If the text no longer matches, the edit fails
  loudly. Costs one request per read; disable with `OLMCP_FRESH_READS=false`.
- **Publish before compile.** Compilation runs on Overleaf's servers, so pending edits are pushed
  first — otherwise "does it still compile?" would answer a question about the old file.
- **Log distillation.** A thesis log runs to thousands of lines of which about twenty matter, so
  only errors (with `l.NN` line references), undefined references, and warning counts survive.
- **Path safety.** Every model-supplied path is validated against `..`, absolute paths and drive
  letters, and zip entries that would escape the project root are skipped.

## Configuration

All configuration is environment variables; see [`.env.example`](.env.example) for the annotated
list. The essentials:

| Variable | Default | Purpose |
|---|---|---|
| `OVERLEAF_SESSION` | — | **Required.** The `overleaf_session2` cookie value. |
| `PUBLIC_URL` | `http://localhost:8080` | Exact public HTTPS origin. OAuth metadata is built from it. |
| `MCP_AUTH_MODE` | `bearer` | `oauth`, `bearer`, or `none`. Use `oauth` for the web clients. |
| `MCP_OAUTH_PASSWORD` | — | **Required for `oauth`.** The passphrase you type on the consent screen. |
| `MCP_BEARER_TOKENS` | — | **Required for `bearer`.** Comma-separated static tokens. |
| `OVERLEAF_BASE_URL` | `https://www.overleaf.com` | Point at a self-hosted instance. |
| `OVERLEAF_EMAIL` / `OVERLEAF_PASSWORD` | — | Self-hosted only: silent re-login when the cookie expires. |
| `OLMCP_AUTO_PUSH` | `true` | Publish each accepted edit immediately. |
| `OLMCP_READ_ONLY` | `false` | Refuse every mutating tool. |
| `OLMCP_FRESH_READS` | `true` | Re-fetch a file from Overleaf before reading or editing it. |
| `OLMCP_DATA_DIR` | `./data` | Where project mirrors and OAuth state live. |
| `TRUST_PROXY` | `1` | Number of reverse proxies in front. Set to `0` if directly exposed. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. Logs go to stderr. |

## Security model

**This server is equivalent to remote write access to your Overleaf account.** Treat it that way.

- **Credentials.** The session cookie lives in memory only. Every log line and every tool result
  passes through redaction, including the configured cookie value itself.
- **Approval passphrase.** `MCP_OAUTH_PASSWORD` is the only thing standing between a stranger and
  your papers. The server **refuses to start** in `oauth` mode without it.
- **Callback allowlist.** Dynamic client registration only accepts known vendor callbacks and
  loopback addresses. Without that, the server would be an open redirector handing out
  authorization codes.
- **Tokens.** Opaque and server-side, so revocation is immediate. Refresh tokens rotate, and
  replaying a rotated token revokes its whole chain.
- **Least privilege.** `OLMCP_READ_ONLY=true` disables every mutating tool, and OAuth scopes
  (`overleaf.read`, `overleaf.write`) let you hand out a read-only connection.
- **Rate limiting.** Registration, token, and consent endpoints each have their own budget.
- **Destructive operations.** `delete_file` requires explicit confirmation, a push refuses to
  empty a project outright, and every edit is reversible.

**Suggested rollout:** start with `OLMCP_READ_ONLY=true` and let the assistant read for a while
before you grant write access.

### Security review

This codebase has been through an adversarial review with live reproduction. Every finding below
is **fixed and covered by a regression test** (`npm test`, the `Regression` sections):

| Severity | Issue | Fix |
|---|---|---|
| **Critical** | Under `MCP_AUTH_MODE=bearer` (the default) the OAuth routes were still mounted, and that mode does not require `MCP_OAUTH_PASSWORD` — so **an empty passphrase matched an empty passphrase**, letting anyone self-register a client, approve it, and mint a token with full account access. | An empty passphrase never authorizes. OAuth routes are mounted only in `oauth` mode, and tokens issued earlier stop working outside it. |
| **High** | `pull_project` wiped the mirror before writing, so a failure part-way through left a partial tree; the next push read the missing files as deletions and **removed them from Overleaf**. | Extract to a temporary directory and swap atomically, with rollback. A push also refuses to delete every file at once. |
| **High** | `compile` auto-publishes pending edits but was the one write path with no read-only check, so a read-only connection could upload and delete files through it. | Read-only check added. |
| **High** | The consent screen was unthrottled, so the approval passphrase could be brute-forced. | Rate limited. |
| Medium | `changes()` returned an empty list on a git error (fail-open), silently skipping pushes and disabling the guard that protects unpublished edits. | Now throws (fail-closed). |
| Medium | `undo_last_edit` would reverse a *reload from Overleaf*, pushing a stale copy over browser edits and reporting success. | Only edit commits are undoable; reloads and refreshes are refused explicitly. |
| Medium | Refresh tokens could be replayed concurrently (both requests minted new tokens), and a wrong `parent` field meant family revocation never matched. | Atomic claim (take-and-delete); `parent` now points at the replaced refresh token. |
| Medium | `trust proxy: true` trusted every proxy, so `X-Forwarded-For` could be spoofed to evade rate limiting. | Configurable hop count (default 1); `true` is unreachable. |
| Medium | A failed write permanently poisoned the OAuth store's write chain, breaking all later writes. | The chain stays settled; a single failure no longer propagates. |
| Medium | `search_project` compiled a model-supplied regex and ran it per line on the event loop, so catastrophic backtracking hung the whole server. | Nested-quantifier patterns rejected, plus a per-line cap and a time budget. |
| Low | `use_project` had no read-only check and writes global state, so a read-only connection could retarget another client's edits. | Read-only check added. |
| Low | `MCP_AUTH_MODE=none` granted anonymous write access. | Read-only by default; requires `OLMCP_ALLOW_ANONYMOUS_WRITE=true` to opt in. |
| Low | Static tokens were compared in non-constant time; redaction missed custom cookie names; successful tool output bypassed redaction. | Constant-time comparison, runtime-registered secrets, output redacted too. |

The same review confirmed these were **already correct**: authorization codes are single-use and
expiry-checked; PKCE is S256-only and bound to both `client_id` and `redirect_uri`; the redirect
allowlist is enforced at registration *and* both authorization steps (12 hostile URIs rejected, no
open redirect); path traversal (absolute, drive letters, UNC, `..`) is rejected; zip-slip entries
are skipped rather than extracted.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Client says "not a valid MCP server" | Clients POST `initialize` straight to the registered URL and never use legacy SSE. Make sure you entered `https://domain/mcp` (**not** `/sse`) and that `/healthz` is publicly reachable. |
| Connection times out | Requests come from the vendors' clouds. Check for an IPv4 `A` record, a valid certificate, and no firewall rule limited to your own IP. Anthropic's egress range is `160.79.104.0/21`. |
| Consent page will not open, or authorization fails | `PUBLIC_URL` must match the address clients use **exactly**. The `resource` in the discovery metadata must equal the MCP URL precisely; clients validate it strictly. |
| Tools fail with a session error | `overleaf_session2` changes when you log out or the session expires. Copy it again. Self-hosted instances can set `OVERLEAF_EMAIL` / `OVERLEAF_PASSWORD` for automatic re-login. |
| Changes do not appear in Overleaf | Check `pending_changes`. If `OLMCP_AUTO_PUSH=false`, you need an explicit `publish_changes`. Failed files are listed with reasons in the tool result. |
| Compile fails but the local file looks fine | `compile` publishes first and reports an error rather than compiling stale content. Check `pending_changes`. |

Set `LOG_LEVEL=debug` to see per-call timings and failure reasons.

## Development

```bash
npm install
npm run typecheck     # types only
npm run build         # compile to dist/
npm test              # build, then the full end-to-end suite
npm run dev           # run the TypeScript sources directly
```

### Layout

```
src/
  index.ts              Entry point: validate config, choose the http or stdio transport
  bootstrap.ts          Redirects a dependency's config dir; must be imported first
  config.ts             All configuration and its validation
  auth/                 OAuth 2.1 authorization server
    provider.ts           Authorization codes, PKCE, DCR, token issue and verify
    store.ts              Persistence for clients, codes and tokens
    routes.ts             Discovery metadata, consent screen, token endpoints
    middleware.ts         Bearer enforcement and the 401 challenge
  overleaf/
    session.ts            Authenticated client with re-auth on expiry
    registry.ts           Project resolution, active project, workspace lifecycle
    workspace.ts          The git mirror: pull, change detection, push, undo
    latex.ts              LaTeX structure and summaries
    latexlog.ts           Compile-log distillation
  tools/                22 tool handlers, decoupled from the MCP framework
  transport/http.ts     Express app: MCP endpoint, OAuth, health check
test/smoke.mjs          End-to-end suite (116 checks)
docker/                 Dockerfile, compose, Caddyfile
```

Tool handlers are plain `(ctx, args) => Promise<string>` functions bound to the MCP SDK in one
place (`tools/index.ts`), so the entire tool surface is testable without speaking JSON-RPC.

The suite needs no Overleaf account: the Overleaf side is a stub client that records calls, which
is what makes the dangerous logic — push, undo, refresh, mass deletion — verifiable locally and
repeatably.

## Limitations

- **Binary files** cannot be read or written through the tools; text sources (`tex`, `bib`, `cls`,
  `sty`, …) can.
- **Concurrent edits to the same file are handled conservatively.** A file is re-fetched before
  use, so an edit based on stale text fails instead of overwriting. But if someone else changed a
  *different* file, a push still applies the local mirror's view of it. In collaborative projects,
  `pull_project` first.
- **Compilation uses Overleaf's compiler**; there is no local LaTeX toolchain.
- **Tool paths are text-only and size-limited** (`OLMCP_MAX_FILE_BYTES`, default 2 MB).

## Acknowledgements

The Overleaf side is built on [`@aloth/olcli`](https://github.com/aloth/olcli) (MIT), which talks
to Overleaf's **web session** interface rather than the Git integration. That means LeafMCP
works on Overleaf **free plans** as well as self-hosted instances — Git integration is not
required.

## License

[MIT](LICENSE) © 2026 CherryLemon