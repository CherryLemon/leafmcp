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

- **26 LaTeX-aware tools** — read, search, edit, rename, compile, undo, change sets, and review comments.
- **Edits land in Overleaf within seconds.** Each accepted change is published immediately, so
  your browser shows it without a manual sync.
- **Atomic revisions.** `begin_change_set` groups a multi-file change so it lands all at once, or not at all.
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
                 │  · 26 LaTeX tools     │
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

node dist/index.js --check              # validate config, list every problem, start nothing
node dist/index.js --verify             # exercise every Overleaf call this server makes
node dist/index.js --verify --compile   # ... and include a LaTeX build
node dist/index.js                      # start the server
```

> **Debug in this order.** Run `--verify` before connecting anything: from inside a chat
> window a bad cookie, an incompatible upstream and a broken MCP setup all look the same
> ("something went wrong"). The verifier does not write — no upload, no comment — and reports
> each capability separately, so a failure names the call that broke:
>
> ```
>   ok    sign in and list projects — 12 project(s)
>   ok    project metadata — 4 top-level entr(ies)
>   ok    download the project archive — 812 KB
>   ok    read the archive — 37 file(s), e.g. main.tex
>   ok    download a single file (main.tex) — 9134 bytes
>   ok    list review comments — 2 thread(s)
> ```

**For a first run, use a project you can afford to lose, and set `OLMCP_READ_ONLY=true`.**
Nothing here has been exercised against a live account, so treat the first session as a test
of the bridge itself rather than a real editing session.

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

### On your own machine, with Cloudflare Tunnel

This is the right shape for a home server or a laptop-as-a-server: `cloudflared` dials **out** to
Cloudflare, so you need no public IP, no port forwarding, and no inbound firewall rule — and it
keeps working when your ISP changes your address or puts you behind CGNAT. Cloudflare terminates
TLS, so there is no Caddy in this arrangement.

```bash
CF_TUNNEL_TOKEN=<token> docker compose -f docker/docker-compose.cloudflare.yml up -d
```

The header of [`docker/docker-compose.cloudflare.yml`](docker/docker-compose.cloudflare.yml) has
the dashboard steps, including the one detail that is easy to get wrong: the tunnel's public
hostname must point at `overleaf-mcp:8080` (the compose service name), **not** `localhost:8080`.

Four Cloudflare settings decide whether this works:

| Setting | Value | Why |
|---|---|---|
| `MCP_JSON_RESPONSES` | **`false`** | Cloudflare returns error 524 when the origin sends nothing for 125 seconds, and a JSON-mode tool call sends nothing until it finishes — a slow LaTeX compile can trip it. SSE mode starts responding immediately and then streams. Note this is the **opposite** of the default, which is chosen for a same-host reverse proxy. |
| Bot Fight Mode | **off** | The assistants call from cloud IPs with non-browser user agents, so bot protection 403s them — and the client only reports "not a valid MCP server". |
| Cloudflare Access | **do not enable** | It requires an interactive login, which server-to-server clients cannot perform. LeafMCP runs its own OAuth; the consent page is opened in *your* browser, so Access would work for that one step and fail for everything else — a confusing half-broken state. |
| SSL/TLS mode | **Full** | Flexible is insecure and a common source of subtle breakage. |

Also add a cache-bypass rule for the hostname. `POST /mcp` is not cached by default, but a stale
`.well-known/oauth-protected-resource` would break OAuth discovery.

**Be realistic about uptime:** with this arrangement the server is available only while your
machine is awake and online. A laptop that sleeps looks like a flaky assistant, and the error
messages clients produce are not specific about why.

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

26 tools. Read tools carry `readOnlyHint`, mutating ones carry `destructiveHint`, and clients use
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
| `edit_file` | **Preferred.** Replace an exact snippet; ambiguous matches are refused, and `expected_hash` refuses the edit if the file moved on since it was read. |
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
| `edit_history` | Recent changes, each labelled with its operation id. |
| `undo_operation` | **Reverse one specific operation**, leaving everything after it in place. |
| `undo_last_edit` | Reverse the last N edits and republish. |
| `begin_change_set` | Open a change set: the edits that follow are published together, or not at all. |
| `commit_change_set` | Publish the open change set in one go. A failure leaves it open to retry. |
| `abandon_change_set` | Discard the open change set and return the mirror to the state it opened from. |

### Review comments

| Tool | Description |
|---|---|
| `list_comments` | List comment threads with file and line. |
| `add_comment` | Add a comment, optionally anchored to a line. |
| `reply_to_comment` | Reply within a thread. |
| `resolve_comment` | Mark a thread resolved. |

### Design notes

- **Mirror plus per-file sync state.** Each project has a locally cached, git-versioned mirror.
  What Overleaf holds is recorded per file, as a content hash, rather than as one project-wide
  ref: a single ref cannot describe a state where one file was refreshed while another still has
  unpublished edits, and the version that tried made the pending file look published. Hashing
  also keeps git out of the decision, so a failed `git add` can no longer produce a confident
  "nothing to publish".
- **One writer per project.** Every mutating tool runs under that project's lock, so the whole refresh → read → write → commit → publish sequence is atomic with respect to other clients. Without it, two edits arriving together both read the same base and the second discards the first. Different projects stay fully concurrent. This serialises within one process; two server instances must not share a data directory.
- **A partial publish is an error, not a footnote.** If any file fails to reach Overleaf, the tool result is flagged as an error, because a warning inside an otherwise successful response is easy for a model to summarise away as "done" — and the user then believes their paper was updated.
- **Edits can be pinned to a version.** `read_file` reports a `sha256:` prefix and `edit_file` accepts it as `expected_hash`, so an edit written against text that has since changed is refused rather than applied. Overleaf offers no atomic conditional write, so this cannot close the race between the check and the upload — but it turns the common case, "the user edited this after the model read it", into a conflict someone has to look at.
- **Change sets make a revision atomic.** For work that spans several files, or that should not be visible half-finished, `begin_change_set` suspends publishing: the edits accumulate locally and reach Overleaf together on `commit_change_set`. Without it a five-file revision arrives one file at a time, and anyone reading the paper in between sees a state that never existed as a whole. `abandon_change_set` discards the lot, and nothing was ever published, so there is nothing to undo remotely.
- **Every mutating call is an operation with an id.** Results and `edit_history` report it, and `undo_operation` reverses exactly that one, leaving later work alone. It reverts rather than resets, so the original edit stays in history and a mistaken undo is itself undoable. When a later edit has rewritten the same lines, the reversal is **refused** with the conflict reported — guessing which version was meant is how a tool destroys work it was asked to protect.
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
| **Critical** | `.git` was reachable through the file tools. That is a command-execution primitive rather than mere repository corruption: git runs programs named by `core.fsmonitor`, `core.hooksPath` and `filter.*.clean`, and `git add -A` triggers them — confirmed against git 2.47, where all three vectors executed a payload. A prompt injection reaching one write call would have become code execution on the host. | Git's directory now lives **outside** the work tree (verified: the work tree contains no `.git` at all), the path layer rejects every `.git*` name, archives with such entries are skipped, and the git child runs with a minimal environment, no global config, and hooks and fsmonitor disabled. |
| **Critical** | Under `MCP_AUTH_MODE=bearer` (the default) the OAuth routes were still mounted, and that mode does not require `MCP_OAUTH_PASSWORD` — so **an empty passphrase matched an empty passphrase**, letting anyone self-register a client, approve it, and mint a token with full account access. | An empty passphrase never authorizes. OAuth routes are mounted only in `oauth` mode, and tokens issued earlier stop working outside it. |
| **High** | `pull_project` wiped the mirror before writing, so a failure part-way through left a partial tree; the next push read the missing files as deletions and **removed them from Overleaf**. The rollback added in the first fix was itself wrong — it deleted work-tree entries that had not been backed up yet, destroying the files it existed to protect. | Extract to a temporary directory and swap atomically. The rollback removes only what was installed and restores from the backup's actual contents. A push also refuses to delete every file at once. |
| **High** | `compile` auto-publishes pending edits but was the one write path with no read-only check, so a read-only connection could upload and delete files through it. | Read-only check added. |
| **High** | Publishing continued into the deletion phase after an upload failed. A rename is an upload plus a delete, so this left the project with neither the new file nor the old one — silent data loss from an operation the user read as a rename. | Any upload failure cancels the deletion phase; the change stays pending and the outcome reports that deletions were held back. |
| **High** | The consent screen was unthrottled, so the approval passphrase could be brute-forced. | Rate limited. |
| Medium | `changes()` returned an empty list on a git error (fail-open), silently skipping pushes and disabling the guard that protects unpublished edits. | Now throws (fail-closed). |
| Medium | `undo_last_edit` would reverse a *reload from Overleaf*, pushing a stale copy over browser edits and reporting success. | Only edit commits are undoable; reloads and refreshes are refused explicitly. |
| Medium | Refresh tokens could be replayed concurrently (both requests minted new tokens), and family revocation never actually matched — so a replayed token was merely refused while the stolen successor kept full access, contradicting what the README claimed. | Tokens carry a grant id; the claim is atomic; a replayed token revokes every token in its grant, access tokens included, so revocation is immediate. The regression test asserts the successor dies, not just that the old token is refused. |
| Medium | `trust proxy: true` trusted every proxy, so `X-Forwarded-For` could be spoofed to evade rate limiting. | Configurable hop count (default 1); `true` is unreachable. |
| Medium | A failed write permanently poisoned the OAuth store's write chain, breaking all later writes. | The chain stays settled; a single failure no longer propagates. |
| Medium | `search_project` compiled a model-supplied regex and ran it per line on the event loop, so catastrophic backtracking hung the whole server. | Nested-quantifier patterns rejected, plus a per-line cap and a time budget. |
| Medium | `edit_file` passed replacement text through `String.replace`, which expands `$$`, `$&` and `$1`. Writing `$$E = mc^2$$` produced `$E = mc^2$` — display math silently destroyed by the one tool whose job is editing LaTeX. The two replacement branches also disagreed. | A function replacer makes the text literal in both branches. |
| Medium | The ReDoS guard was a heuristic for nested quantifiers, and `(a|aa)+$` walked past it. Measured: 36 characters took ~6 seconds and 40 never finished, against a 4,000-character line cap — so one line of one file could wedge every request. | Regex evaluation moved into a killable child process with a hard deadline, which is the only thing that stops a match already running. |
| Medium | Dynamic client registration is unauthenticated by design, and nothing bounded it: `client_name` had no length limit, there was no cap on the number of clients, and the endpoint accepted the global 4 MB body. Each stored client is rewritten in full on every token operation, so this was an anonymous way to make the server do unbounded work. | Per-field length limits, a cap on registered clients, and a 16 KB body limit for the OAuth routes (the MCP route keeps 4 MB because a `write_file` call carries a file). |
| Medium | Project import had no limits. `pull` holds the whole archive in memory, so a project with a hundred thousand entries, one enormous entry, or a deeply nested path was enough to exhaust the process. | Entry count, per-entry and total extracted size, and path depth are all bounded; the declared size is checked before decompressing and the real size after, since a crafted archive can understate it. |
| Medium | The consent screen could be framed and cached. It is the one page where a click decides whether a stranger gets write access to someone's papers. | CSP with `frame-ancestors 'none'` and `form-action 'self'`, plus `X-Frame-Options: DENY`, `Cache-Control: no-store`, a referrer policy and `nosniff`. There is no script on the page at all. |
| Low | The Docker build used `npm install` while CI used `npm ci`, so an image could contain dependency versions no lockfile ever pinned. | Both stages use `npm ci`. |
| **High** | Sync state was a single project-wide commit ref, so refreshing one file from Overleaf advanced the baseline past *every* file — another file's unpublished edit then looked already published and was never uploaded. Reproduced: an unpublished `a.tex` disappeared from `pending_changes` when `b.tex` was refreshed. | Sync state is now a per-file manifest of content hashes. Updating one entry cannot speak for another file, and the regression test asserts the pending file survives. |
| **High** | Change detection asked git, which fails open: `git add`'s exit code was ignored, so a failed staging (a full disk, an unreadable file) could leave the index untouched and `git diff --cached` then reported no changes — the server would announce "already synced" about edits it had never sent, and the same empty list disabled the guard protecting unpublished work. | Detection hashes the files directly. Git is no longer in the trust path for deciding what to publish. |
| **High** | Read-only tools were outside the project lock, yet reading initialises the mirror, pulls it and refreshes files — all mutations. A read could race an edit and advance sync state on its behalf. | Every tool that can name a project now takes that project's lock. `compile` scopes its own critical section so a minute-long remote build does not block other clients. |
| **Medium** | Revocation deleted token rows but recorded no status, so a refresh already in flight when the grant was revoked could still write fresh, valid successors. Deleting records is a snapshot, not a state. | Grants have a durable revoked marker; minting consults it inside the same synchronous block as the insert, so a late write is refused rather than resurrecting the grant. |
| **Medium** | Upgrading from the old in-tree `.git` layout had no migration: the mirror looked uninitialised, so the next pull replaced the work tree — discarding unpublished edits — and the old configuration, which had lived inside the assistant-writable tree, would have been trusted. | Migration moves the git directory out, **replaces** the old config rather than reading it, clears hooks, and rebuilds the manifest from the old watermark so unpublished files stay unpublished. A work tree with files but no sync record now refuses to be pulled over. |
| **Medium** | The rate limiter kept one bucket per client address with no ceiling, and cleaned up by scanning the whole table once it grew past 1,000 keys — so the defence became the attack. The obvious fix, evicting the oldest bucket, is worse: an attacker rotating addresses evicts the record of their own abuse and starts over. | The table is capped and expired entries are dropped from the front (O(1) amortised, since keys are inserted in expiry order). Once full, unknown addresses share one overflow budget rather than displacing existing ones. |
| **Medium** | A full client table blocked every new registration until an operator edited a JSON file by hand; registrations accumulated with no reclamation. | Registrations that hold no live token and have no authorization in progress are reclaimed to make room. A client mid-consent is never reclaimed, and a reclaimable one simply registers again. |
| **Medium** | The isolated search process read files itself, so it inherited none of the read tool's limits — one large asset could be pulled into memory per search, and searches could be multiplied into as many processes as there were requests. | Per-file and total byte budgets inside the worker, plus a ceiling on concurrently running searches. |
| **Medium** | `delete_file` on a directory removed everything inside it, published the deletions, and reported success — the caller had named a folder, not its contents. | A directory is refused on the first attempt and its contents are listed; `recursive=true` is required to proceed, and the result states how many files went. |
| **Medium** | Only a target's final path segment was checked for being a symlink, so a linked *directory* let a write land outside the project while the path still looked contained. | The resolved ancestor chain is checked against the resolved project root, for writes, moves and deletions. The remaining check-to-open window is documented rather than claimed closed. |
| **Medium** | Credential redaction registered only the literal secret, so a value that travelled percent-encoded appeared in logs in a form the pattern did not match. | Secrets are registered with their decoded variant as well, one level deep — repeated decoding of attacker-influenced text is its own problem. |
| **Low** | Extra callback patterns were matched as regular expressions against a URL, so an unescaped `.` in a hostname quietly widened what was accepted, and an unanchored pattern matched a URL that merely contained the callback as a parameter. | Exact URLs are the preferred configuration (`MCP_OAUTH_REDIRECT_URLS`); patterns are validated at startup and the server refuses to run unanchored or unescaped ones, with `--check` explaining why. |
| **Low** | Four OAuth settings (`MCP_OAUTH_CLIENT_ID`, `_CLIENT_SECRET`, `_AUTHORIZE_URL`, `_TOKEN_URL`) were parsed but never read, implying a pre-registration mode that does not exist. | Removed. This server *is* the authorization server, so those settings had no meaning to implement. |
| **Low** | Session re-authentication matched a bare `login` substring, so an unrelated error mentioning it could tear down a working session; and an old expired call cleared whichever session was current, discarding one another call had just rebuilt. | Matching is phrase-based against the client's actual wording, and only the session that failed is discarded. |
| **Low** | Dot files were hidden from listings but readable by name, and an extensionless one like `.latexmkrc` was classified as binary and refused. | Only git's own names are hidden; a leading dot is no longer treated as an extension. Listing and reading now agree. |
| **Low** | `OAuthStore` initialised from a shared constant with a shallow copy, so every instance pointed at the same nested `clients`, `tokens` and `revoked` objects. One store mutating another's state went unnoticed because production runs a single instance. | A factory function returns genuinely independent state. Found by a test that seeded two stores. |
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
| Tool calls fail after roughly two minutes (Cloudflare error 524) | The origin sent nothing for 125 seconds. Set `MCP_JSON_RESPONSES=false` so responses stream; a JSON-mode call stays silent until the tool finishes. |
| "Not a valid MCP server" only when behind Cloudflare | Bot Fight Mode is rejecting the assistants, which call from cloud IPs with non-browser user agents. Turn it off for the zone, or add a WAF skip rule for the hostname. |
| Connection times out | Requests come from the vendors' clouds. Check for an IPv4 `A` record, a valid certificate, and no firewall rule limited to your own IP. Anthropic's egress range is `160.79.104.0/21`. |
| Consent page will not open, or authorization fails | `PUBLIC_URL` must match the address clients use **exactly**. The `resource` in the discovery metadata must equal the MCP URL precisely; clients validate it strictly. |
| Tools fail with a session error | `overleaf_session2` changes when you log out or the session expires. Copy it again. Self-hosted instances can set `OVERLEAF_EMAIL` / `OVERLEAF_PASSWORD` for automatic re-login. |
| Not sure which part is broken | Run `node dist/index.js --verify`. It reports each Overleaf call separately and writes nothing, so the failing line names the problem. |
| Changes do not appear in Overleaf | Check `pending_changes`. If `OLMCP_AUTO_PUSH=false`, you need an explicit `publish_changes`. Failed files are listed with reasons in the tool result. |
| Compile fails but the local file looks fine | `compile` publishes first and reports an error rather than compiling stale content. Check `pending_changes`. |

Set `LOG_LEVEL=debug` to see per-call timings and failure reasons.

## Development

```bash
npm install
npm run typecheck      # types only
npm run build          # compile to dist/
npm test               # build, then the full end-to-end suite
npm start              # run the built server
```

For a development loop, run these in two terminals:

```bash
npm run build:watch    # tsc --watch
npm run dev            # builds once, then restarts on every rebuild
```

Everything runs from `dist/`. Node's built-in type stripping does not rewrite the `./x.js`
import specifiers that `tsc` requires in ESM output, so running `src/` directly needs an extra
resolve hook or a runner such as `tsx` — this project stays on plain `tsc` output rather than
adding a dependency for it. The one exception is the search worker
(`src/tools/search-worker.ts`), which imports nothing but Node built-ins so it can also be
launched from source.

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
    journal.ts            Operations and change sets, for undo by id
  tools/                26 tool handlers, decoupled from the MCP framework
    search.ts             Spawns and supervises the isolated search
    search-worker.ts      Runs the pattern somewhere it can be killed
  transport/http.ts     Express app: MCP endpoint, OAuth, health check
test/smoke.mjs          End-to-end suite (273 checks)
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