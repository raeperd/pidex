# Pidex Proof-of-Concept Implementation Prompt

Build a working proof of concept for Pidex from the existing repository. Work autonomously from discovery through verification: inspect the environment, preserve the current workspace, install only necessary dependencies, implement the complete core flow, run tests, launch the production application, and fix failures. Do not stop at a plan, scaffold, disconnected mockup, or UI-only implementation.

The proof of concept should implement the local Pi dashboard described by `docs/reference-prompt.md` while following the repository and runtime boundaries in `docs/architecture.md`. Do not derive product requirements from `docs/prd.md` or `docs/technical-reference.md` for this task.

## Sources of Truth

Read these files completely before changing code:

1. `docs/reference-prompt.md` defines the proof-of-concept behavior, Pi integration, UI, safety rules, and verification expectations.
2. `docs/architecture.md` defines the repository layout, dependency direction, runtime topology, storage responsibilities, and selected technologies.
3. The existing repository defines the starting point and must be evolved in place.

When the documents use different implementation technologies, preserve the behavior from `docs/reference-prompt.md` but use the architecture selected by `docs/architecture.md`. In particular:

- use the existing pnpm workspace rather than creating a new npm project;
- use Svelte 5, Vite, and Tailwind CSS 4 rather than React;
- use Node HTTP and WebSocket rather than Express and Server-Sent Events;
- keep Electron as the server-process supervisor and desktop shell;
- keep shared browser-safe Zod schemas and types in `packages/api`;
- keep Pi JSONL as the conversation source of truth and use SQLite only for Pidex metadata;
- do not add features solely because they appear in the PRD or technical reference.

## Proof-of-Concept Result

Deliver a local, private, responsive Pi control surface that lets the user:

- open a project directory;
- create a native persistent Pi session;
- list and resume native Pi sessions for that project;
- stream assistant text, thinking, and tool activity;
- send a prompt, steer an active run, queue a follow-up, clear supported queues, and stop;
- choose an available model, thinking level, and actual read-only or full tool set while idle;
- rename and compact a session and view useful session statistics when supported by the matched SDK;
- recover the current transcript and run state after a browser reconnect or server restart;
- use the same interface comfortably in Electron and a mobile browser.

The browser is only a control surface. Pi remains the agent and the source of truth for models, authentication, settings, resources, tools, events, and JSONL sessions. Do not build a second agent loop, provider layer, credential store, or transcript database.

Tailscale is not an implementation or live-test requirement for this proof of concept. First make the loopback application complete and reliable. At the end, document the manual `tailscale serve` command from the reference prompt as an optional, unverified follow-up. Do not automate Tailscale, manage Serve configuration, implement pairing, install a service, or block completion on Tailnet access.

## Preserve the Current Architecture

Keep the current workspace structure:

```text
apps/
├── desktop/   # Electron shell and server-process supervisor
├── web/       # Responsive Svelte/Vite/Tailwind client
└── server/    # HTTP, WebSocket, Pi adapter, SQLite, and local security

packages/
└── api/       # Browser-safe Zod schemas and inferred protocol types
```

Maintain this dependency direction:

```text
apps/web ───────────────> packages/api <────────────── apps/server
apps/desktop ───────────> packages/api

apps/desktop ──spawns and supervises──> apps/server executable
```

Rules:

- Keep web transport, snapshots, replay, reconnect, and draft logic inside `apps/web`.
- Keep the real Pi adapter inside `apps/server`.
- Keep `packages/api` free of Electron, Node, browser, and server implementations.
- Never import server implementation code into the web app or Electron main process.
- Use HTTP and WebSocket for ordinary renderer traffic rather than Electron IPC.
- The Electron preload, if needed, must remain narrow, context-isolated, and limited to desktop bootstrap capabilities.
- Add another package only if a genuine second consumer appears.
- Preserve strict TypeScript, native ESM, exact-pinned direct dependencies, the existing pnpm catalog, and one committed `pnpm-lock.yaml`.

## Verify the Real Environment First

Before coding:

1. Inspect the repository, current Git state, workspace manifests, TypeScript configuration, and scaffold source. Preserve all existing and unrelated work.
2. Locate Pi with `command -v pi`. Check `pi --version`, `node --version`, `pnpm --version`, and only whether `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` are set. Never dump the full environment or read, print, copy, or log `auth.json` or any credential value.
3. Read the official documentation and installed package material relevant to the installed Pi version: SDK, sessions, session format, and security.
4. Treat the installed Pi CLI as the compatibility target. Install the exact compatible Pi SDK version locally and pin it and the dependency tree in `pnpm-lock.yaml`. Do not upgrade or modify the global Pi installation.
5. Inspect the matched SDK package's manifest, Node engine, public exports, bundled docs/examples, and public type declarations. Adapt to its real APIs instead of assuming names in this prompt are exact.
6. If the matching SDK cannot be resolved, stop before opening saved sessions, explain the mismatch, and ask whether to install a compatible SDK or update Pi. Never silently combine incompatible versions.
7. Use Pi's Node SDK and session APIs. Use RPC only when the matched SDK has a documented blocker, and explain any fallback before implementing it.

After discovery, write a short implementation checklist and execute it. Do not ask aesthetic questions.

## Path and State Rules

- Build in the current Pidex repository, never inside Pi's configuration or session directories.
- Resolve Pi's configuration directory and session storage independently through the matched SDK or settings services.
- Respect `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, and Pi's documented session-directory precedence. Do not hard-code or derive a session root when Pi can resolve it.
- Treat the canonical selected project path as Pi's `cwd`.
- Keep durable chats in Pi's native JSONL sessions. Never rewrite JSONL directly and never duplicate transcript content in SQLite.
- Use Pi's public session APIs to create, list, open, traverse, and resume sessions.
- Give the browser opaque workspace and session IDs. Resolve them server-side to canonical paths returned by validated Pi APIs. Never accept an arbitrary session-file path from the browser.
- Reuse Pi's existing authentication through the SDK. Never copy, expose, or return credentials.
- Browser storage may contain only harmless UI preferences, recent successful project paths, delivery mode, and unsent drafts.

## Fixed Stack

Use the technologies fixed by `docs/architecture.md` and the existing manifests:

- Node.js 24 LTS and pnpm workspaces;
- strict TypeScript and native ESM;
- Electron 41 with a sandboxed, context-isolated renderer;
- Svelte 5, Vite, and Tailwind CSS 4;
- Zod 4 for browser-safe API and persisted-data validation;
- Node's built-in HTTP and `node:sqlite` modules;
- `ws` on the server and native `WebSocket` in the browser;
- Pi's exact-matched Node SDK;
- Vitest and Playwright Chromium for verification.

Use a safe Svelte-compatible GFM Markdown renderer. Raw HTML must remain disabled. Apply an explicit link policy that allows only safe `http:`, `https:`, and `mailto:` URLs, rejects executable or unknown schemes, opens external links with `noopener noreferrer`, and disables remote images by default.

Do not add React, SvelteKit, Express, SSE, a generic provider abstraction, a second transcript store, public hosting, telemetry, analytics, terminal or Git interfaces, or unrelated dashboard features.

## Required Commands

Provide coherent root commands and verify them:

```text
pnpm dev
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm start
```

Use Vite's development proxy so browser traffic remains same-origin. Production startup must use compiled server and web artifacts. The server must bind to literal `127.0.0.1` on port `4783` by default. Permit only a validated `PORT` override from 1024 through 65535, print the exact local URL, and fail clearly on `EADDRINUSE`. Do not allow a host override that widens exposure.

Electron must spawn and supervise the compiled server child process, wait for readiness, capture bounded logs, restart unexpected exits safely, load the shared web app, and stop the child on explicit Quit. The server must also remain independently startable for browser development and tests.

## Build Order

1. Complete environment discovery and version matching.
2. Define the shared Zod protocol and Pi adapter interface, then connect the matched real Pi SDK.
3. Complete one end-to-end vertical slice: open project, create session, send, stream through WebSocket, settle, reconnect, restart, and resume.
4. Add the remaining real Pi session controls.
5. Add local security, responsive polish, production serving, Electron supervision, tests, and documentation.
6. Run the full suite after every material fix and finish without TODO replacements for required behavior.

## Pi Integration

Prefer one public Pi agent-session and session-manager instance per live web chat, adapting the exact construction and replacement lifecycle to the matched SDK.

For each live chat:

- create a persistent Pi session for the selected canonical `cwd`, or resume a session returned by Pi's listing APIs;
- restore its cwd, name, model, thinking level, active branch, messages, and compaction state;
- show only the active branch or context rather than flattening abandoned branches;
- load normal global and project settings, instruction files, skills, prompt templates, extensions, custom models, and tools through Pi's documented resource loader;
- honor existing project-trust decisions and never silently approve trust. If protected resources are skipped, keep the session usable and show a clear notice;
- list authenticated and available models from Pi rather than hard-coding them. If none are available, instruct the user to run Pi and log in locally; do not build a browser credential form;
- default new browser chats to a real read-only tool allowlist such as `read`, `grep`, `find`, and `ls`, using the exact tools exposed by the installed SDK;
- allow switching to Pi's real full tool set only while idle. If tool selection applies only at construction, dispose and reopen the same idle session exactly once with the new set;
- clearly explain that read-only is a model-tool allowlist, not an operating-system sandbox, and does not make extensions harmless;
- implement model and thinking changes, rename, compact, stats, prompt, steer, follow-up, abort, supported queue clearing, and clean disposal through documented public APIs.

Bind supported extension interactions through Pi's documented non-TUI UI context. Bridge select, confirm, single-line input, multiline input, notifications, and status to accessible browser dialogs or events. Match responses by request ID, cancel pending requests on session disposal, never auto-confirm security questions, and fail visibly rather than hanging when a TUI-only interaction has no safe browser equivalent.

Discover extension commands, prompt templates, and skills through Pi and expose a lightweight `/` autocomplete menu. Send selected entries through Pi's normal prompt expansion. Do not claim unsupported built-in TUI commands work; implement New, Resume, Rename, Compact, model, thinking, and tools as explicit web actions.

## Session Ownership and Run Lifecycle

Maintain server-side mappings from opaque chat IDs to live Pi sessions and from canonical session files to live chat IDs.

- Never open the same session file in two live agent-session instances inside this server process.
- A second browser attaches to the existing live chat or receives a clear conflict; it never becomes a second writer.
- Document that the process cannot prevent an unrelated terminal or dashboard process from opening the same native Pi session concurrently.
- During a live run, the normalized in-memory event stream is authoritative. Do not reread and append JSONL after every turn.
- After resume or server restart, rebuild the snapshot through Pi's public active-context API rather than flattening raw stored entries.
- Use Pi entry, message, and tool-call IDs where available. Never deduplicate by fuzzy text or timestamps alone.
- Reject stale events from replaced or disposed sessions with a per-chat generation or run ID.
- A server restart may replace temporary web IDs, but all saved Pi sessions must still be listed and resumable.

Normalize the installed SDK's real events for:

- message start, update, end, and text or thinking deltas;
- tool execution start, update, and end;
- queue changes;
- compaction and automatic retry;
- extension and resource errors;
- the event or promise that proves the entire session-level run has settled.

Do not mark a run complete at an ordinary message-end or agent-end event if retry, recovery, or a queued continuation can still follow. Prefer a documented session-level settled signal. Otherwise use the tracked prompt promise as the primary completion signal and confirm that the session is idle and supported queues are empty. Do not invent SDK event names.

An idle Send uses Pi's prompt API. While busy, Steer must use the matched SDK's steering semantics and Follow-up must use its queued continuation semantics. Stop aborts Pi, clears supported queues, and remains visibly in Stopping state until the run settles.

## HTTP and WebSocket Contract

Implement typed, Zod-validated equivalents of the reference prompt's API operations, adapted to WebSocket streaming:

- `GET /api/health`;
- `GET /api/bootstrap` for non-secret application and Pi status;
- `POST /api/workspaces/open` with a canonicalized project path;
- `GET /api/workspaces/:workspaceId/sessions`;
- `POST /api/chats` and `POST /api/chats/resume`;
- `GET /api/chats/:chatId` for a full authoritative snapshot;
- a WebSocket endpoint for snapshot, replay, live events, and connection state;
- message operations for normal, steer, and follow-up delivery;
- abort, queue-clear, config, rename, compact, extension-dialog response, and dispose operations.

Apply small explicit request and message limits. Use one consistent JSON error shape and never expose production stack traces.

Define a browser-safe discriminated union for snapshots, connection state, run status, messages, text and thinking deltas, tool activity, queues, notices, extension UI requests, and session metadata.

For WebSocket continuity:

- negotiate a protocol version on connection;
- use monotonically increasing event IDs and a bounded recent-event buffer per chat;
- send a complete authoritative snapshot on initial connection;
- replay from the last acknowledged event ID only when the full range remains available, otherwise replace state with a fresh snapshot;
- reconcile by stable item IDs so reconnect never duplicates content;
- use heartbeat and liveness checks and clean up subscribers on close;
- show Connected, Reconnecting, and Disconnected states in the UI;
- never stop Pi because a socket closed.

Bound tool output before sending it to the browser. Include a concise argument summary, running/success/error state, truncated preview, and only reasonably sized safe results. Never place multi-megabyte output in a WebSocket message.

## Finished Interface

Desktop layout:

- a persistent 260–300 px sidebar with New chat, current project, and searchable recent sessions;
- a main column with compact project, model, thinking, and tool controls;
- a readable conversation area and bottom composer.

Below roughly 820 px:

- turn the sidebar into an accessible drawer with scrim, labelled menu button, Escape handling, and sensible focus restoration;
- use full-width chat, wrapped controls, comfortable touch targets, and `env(safe-area-inset-bottom)`;
- verify down to 320 px and around 390 × 844 px;
- do not depend on hover.

Conversation behavior:

- render user and assistant messages, collapsible thinking, compact collapsible tool activity, queues, retry and compaction notices, and actionable errors;
- batch streaming updates rather than rerendering the whole transcript for every token;
- render completed assistant messages as safe GFM;
- keep code and tables horizontally scrollable inside their containers;
- autoscroll only while the user is near the bottom, otherwise show Jump to latest.

Composer behavior:

- provide a growing multiline input with a persisted per-session draft;
- desktop Enter sends and Shift+Enter inserts a newline;
- mobile always provides an explicit Send button;
- Send becomes Stop while active;
- while active, expose Steer and Follow-up and show queued counts;
- disable model, thinking, and tool changes while busy.

Handle polished states for no project, no sessions, no authenticated model, missing project, SDK initialization failure, reconnecting, disconnected, prompt rejection, and run error. Use semantic HTML, visible focus, accessible dialogs and drawer, system light/dark themes, and reduced-motion support. Keep the conversation central rather than filling the page with decorative cards.

## Local Security

- Bind only to `127.0.0.1`, never `0.0.0.0`, a LAN address, or a Tailscale address.
- Do not enable CORS.
- Issue a random per-process same-origin CSRF token in bootstrap and require it in a custom header on every HTTP mutation.
- Reject clearly cross-site `Origin` and `Sec-Fetch-Site` values.
- Allow loopback Host values. Support an explicitly configured Tailscale Serve hostname only as an optional reverse-proxy origin; trust forwarded protocol and host headers only when the immediate peer is loopback.
- Read allowed project roots from `WORKSPACE_ROOTS`, using the platform path delimiter, and default to the user's home directory.
- Canonicalize roots and candidate projects with `realpath`, require existing directories, and use filesystem-aware descendant checks rather than string prefixes.
- Validate opaque session IDs against fresh Pi listing results and resolved Pi session roots. Block traversal and symlink escapes.
- Never return or log API keys, OAuth tokens, authorization headers, credential files, raw environments, private keys, `.env` content, or arbitrary files.
- Do not add a direct shell-execution endpoint; coding actions go through Pi tools.
- Use restrictive production security headers and CSP, local assets only, `Referrer-Policy: no-referrer`, escaped non-Markdown fields, and bounded display payloads.
- Document prominently that Pi has no built-in sandbox and runs with the host user's permissions. Tailscale controls network reachability; it does not sandbox Pi.
- Do not add public hosting, Tailscale Funnel, telemetry, analytics, or a public-share feature.

## Tailscale Documentation Only

After the loopback application is working, document but do not execute or test:

```sh
tailscale serve --bg http://127.0.0.1:4783
tailscale serve status
```

If the port changes, substitute the effective value. Explain that Serve provides a private Tailnet HTTPS URL, both devices must be in the intended Tailnet, access controls should restrict use to the owner, Funnel must not be enabled, and `--bg` persists the proxy configuration but does not start Pidex.

Do not implement automatic Serve setup, pairing, device credentials, revocation, remote-access settings, autostart installation, or OS services in this proof of concept.

## Tests Without Model Spend

Use the real Pi SDK for integration checks. Default automated checks should cover non-inference behavior where possible, including:

- project-root containment, symlink escape, and path-prefix traps;
- opaque session validation and single live ownership;
- active-branch snapshot restoration;
- Pi event normalization and bounded tool previews;
- send, steer, follow-up, queue clearing, abort, retry, compaction, and settled state;
- reconnect replay and resnapshot without duplicates;
- stale-event rejection after session replacement;
- extension dialog round trips and safe cancellation;
- CSRF, origin, Host, request-size, and secret-redaction behavior;
- malicious Markdown and link schemes;
- desktop new/send/stream/tool/stop and resume flows;
- mobile drawer, composer, stream, reconnect recovery, and keyboard focus.

Install only Playwright Chromium for browser tests. Default tests must never send a paid model request or require Tailscale. Keep prompt-dependent verification in a clearly opt-in real-Pi smoke script excluded from normal test commands.

## Out of Scope for This Proof of Concept

- Automated Tailscale setup, Tailnet testing, pairing, or device management;
- OS-native autostart or background service installation;
- requirements found only in `docs/prd.md` or `docs/technical-reference.md` rather than the reference prompt or architecture;
- public, LAN, Funnel, relay, SSH, or cloud access;
- agents other than Pi or a generic provider abstraction;
- profiles, voice, `/btw`, side agents, or browser editing of Pi credentials and settings;
- remote filesystem browsing or editing;
- a terminal, Git UI, checkpointing, worktree management, schedules, or orchestration;
- public deployment, telemetry, or analytics.

## Definition of Done

Do not hand off until:

1. strict typecheck, default tests, Playwright, and production build pass;
2. `pnpm start` serves the compiled application on `127.0.0.1:4783` by default, prints the URL, rejects invalid ports, fails clearly when occupied, and answers `/api/health`;
3. Electron supervises the server and loads the same production Svelte client used by a mobile browser;
4. native Pi sessions can be listed, created, resumed, and recovered after server restart;
5. prompt, streaming text and thinking, tools, steer, follow-up, queue clearing, Stop, retry, compaction, settled state, and supported extension dialogs work through the real Pi adapter;
6. the matched real Pi adapter supports a documented opt-in smoke path without exposing credentials;
7. reconnect creates no duplicate content and the server never opens two live writers for one session file;
8. desktop and mobile layouts are manually checked at representative sizes;
9. built assets, sampled API responses, and logs contain no credential values or raw environment data;
10. the README documents install, development, test, build, start, architecture, Pi state, trust, no-sandbox risk, troubleshooting, the optional manual Tailscale Serve command, and intentionally omitted features.

At the end, start the production app and report:

- the local URL;
- the exact restart command;
- the optional manual Tailscale Serve command, clearly marked untested;
- a concise architecture summary;
- major files created or changed;
- checks run and their outcomes;
- any real limitation imposed by the installed Pi SDK version.
