# Pidex

Pidex is a local, private control surface for the installed Pi coding agent. The browser and Electron renderer are clients only: Pi’s SDK owns authentication, models, resources, tools, agent execution, and native JSONL conversation sessions. SQLite stores only Pidex metadata, durable client actions, run outcomes, and session revisions—never transcripts or credentials.

## Requirements and setup

- Node.js 24 LTS (`^24.13.1`; the matched Pi SDK requires at least `22.19.0`)
- pnpm `11.13.0`
- Pi CLI and SDK `@earendil-works/pi-coding-agent@0.80.10`

```sh
pnpm install
pnpm exec playwright install chromium
```

The SDK is exact-pinned and the dependency tree is committed in `pnpm-lock.yaml`. Pidex reuses Pi’s existing local login; it does not display, copy, or store credentials. If no model appears, run `pi`, use `/login`, then reopen the project.

## Commands

```sh
pnpm dev          # fake Pi server + Vite client for safe development
pnpm typecheck
pnpm test         # deterministic; never calls a paid model
pnpm test:e2e     # deterministic Playwright Chromium suite
pnpm build
pnpm start        # compiled browser app and API on 127.0.0.1:4783
pnpm start:desktop
```

Production restart command:

```sh
pnpm build && pnpm start
```

`PORT` may be an integer from 1024 through 65535. The host is fixed at literal `127.0.0.1` and cannot be widened. `WORKSPACE_ROOTS` is a platform-delimited allowlist of project roots and defaults to the current user’s home directory. `PIDEX_STATE_DIR` can relocate Pidex’s metadata database. `PIDEX_TAILSCALE_HOST` may name one explicitly allowed Tailscale Serve hostname; forwarded headers are not trusted from non-loopback peers.

## Architecture

```text
apps/web ───────────────> packages/api <────────────── apps/server
apps/desktop ───────────> packages/api
     │
     └── supervises compiled apps/server child ──> Pi SDK 0.80.10
```

- `packages/api`: browser-safe Zod schemas and inferred protocol types.
- `apps/server`: Node HTTP/WebSocket host, request security, replay buffers, durable run/action state, paged resources, native Pi adapter, deterministic fake, and SQLite metadata.
- `apps/web`: responsive Svelte 5/Tailwind 4 client, WebSocket replay/reconnect, stable-item reconciliation, drafts, response copying, offline recovery, bounded transcript/tool paging, safe GFM, mobile drawer, and extension dialogs.
- `apps/desktop`: sandboxed/context-isolated Electron 41 shell that starts, health-checks, logs, restarts, and shuts down the compiled server child. Its preload exposes only the native project-folder chooser.

The server issues an authoritative, revisioned snapshot on a new socket, keeps a bounded monotonically numbered event buffer, replays only complete retained ranges, and resnapshots otherwise. Socket loss never stops Pi. Every prompt is recorded durably before the one Pi call; replaying its client action ID returns the stored outcome, conflicting reuse is rejected, and Stop targets the exact host-issued run ID. A crash-interrupted action is shown as ambiguous and blocks new work until acknowledged. A server restart may replace temporary chat IDs, but the SDK lists the same native sessions again. A session file has only one live writer inside one Pidex server; Pi cannot prevent an unrelated terminal or second dashboard process from opening that file concurrently.

Authoritative snapshots and transcript pages are bounded. Older Pi JSONL items are loaded explicitly, and large tool results stay out of WebSocket events and are fetched in chunks of at most 16 KiB. Completed assistant responses have a one-action Copy control with visible clipboard-denial feedback. While disconnected, the composer remains a local draft only and the UI says that host data is unavailable rather than implying it was deleted.

## Pi state, trust, and safety

Pidex resolves the Pi agent directory with `getAgentDir()`. Session placement follows `PI_CODING_AGENT_SESSION_DIR`, then Pi’s `sessionDir` setting, then the SDK default. It lists and opens only exact paths freshly returned by `SessionManager.list()`, and rebuilds resumed transcripts from `buildContextEntries()` so abandoned branches are not flattened.

Project-local Pi resources are loaded only when Pi has a saved trust decision or global `defaultProjectTrust` is `always`. Otherwise protected resources are skipped and the UI shows a notice; Pidex never silently approves trust. Pidex Desktop can save an explicit approval through Pi’s own trust store after confirmation. Context files that Pi treats as unprotected continue to follow SDK behavior, and bounded SDK resource diagnostics are visible in the workspace UI.

**Pi has no built-in sandbox.** Read-only mode is a real model-tool allowlist (`read`, `grep`, `find`, `ls`), not an operating-system security boundary, and extensions still run with the host user’s permissions. Full mode exposes Pi’s configured tool registry. Use a VM, container, or OS sandbox for untrusted or unattended work.

Completed assistant Markdown is parsed as GFM with raw HTML escaped, remote images disabled, DOM sanitization, and an explicit `http:`, `https:`, and `mailto:` link allowlist. Tool output, bodies, WebSocket messages, and replay history are bounded. Mutations require a random per-process CSRF header; cross-site origins, cross-site fetches, and unapproved Host values are rejected. There is no CORS, shell endpoint, telemetry, analytics, public share, credential form, or transcript database.

## Optional real-Pi smoke check

The default suite uses the fake adapter. This inspection sends no model request:

```sh
pnpm build
pnpm smoke:real -- /absolute/project/path
```

An explicitly opt-in paid turn is available with `--prompt`:

```sh
pnpm smoke:real -- /absolute/project/path --prompt "Reply with OK"
```

## Optional Tailscale Serve (not automated or verified)

After Pidex is running locally:

```sh
tailscale serve --bg http://127.0.0.1:4783
tailscale serve status
```

Serve provides a private Tailnet HTTPS URL; both devices must be in the intended Tailnet and ACLs/grants should restrict access to the owner. Do not enable Funnel. `--bg` persists the proxy configuration but does not start Pidex. If the port changes, substitute it in the command. Pidex deliberately does not automate Serve, pairing, device credentials, revocation, autostart, or OS services.

## Troubleshooting

- `PORT ... already in use`: stop the other listener or choose a valid unprivileged port.
- Project rejected: add its canonical ancestor to `WORKSPACE_ROOTS`; symlink escapes and prefix lookalikes are intentionally blocked.
- No models: authenticate in the local Pi TUI with `/login`.
- Project resources skipped: review and save the trust decision in Pi locally.
- Run interrupted: review the restored Pi transcript, then acknowledge the ambiguous run before sending another prompt; Pidex will never rerun it automatically.
- Large tool output: expand the tool card and load additional bounded chunks. Output beyond the host safety ceiling is marked explicitly.
- Reconnecting: confirm `pnpm start` is still active; the browser will replay or resnapshot automatically.
- Electron cannot become ready: run `pnpm build` first and check for a port conflict.

Intentionally omitted: public/LAN/Funnel hosting, automatic Tailscale setup, pairing/device authentication, OS services, generic providers, profiles, voice, side agents, terminal/Git/file editors, worktrees, scheduling/orchestration, provider credential editing, telemetry, and other non-coding-agent remote administration.
