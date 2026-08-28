# Pidex Architecture

## Repository

```text
packages/
├── desktop/   # Electron shell and server process supervisor
├── web/       # Responsive Svelte, Vite, and Tailwind client
├── server/    # HTTP, WebSocket, Pi, SQLite, auth, and Tailscale
├── api/       # Browser-safe Valibot schemas, oRPC contract, and inferred types
├── e2e/       # Cross-application Playwright workflows
└── tooling/   # Repository scripts
```

- Keep the web connection code inside `packages/web`.
- Keep the Pi SDK integration inside `packages/server`.
- Add more packages only when there is a second consumer.

## Runtime

```text
Electron main ──spawns and supervises──> server child process ──> Pi SDK
      │                                         │
      │                                         ├──HTTP/WS──> Electron renderer
      │                                         └──HTTPS/WS─> mobile browser
      └──loads the shared Svelte web app
```

- Electron starts the packaged server executable as a child process.
- Electron checks readiness and owns restart, logs, and shutdown.
- The renderer never imports server code; it uses HTTP and WebSocket.
- Mobile uses the same web build and API through Tailscale Serve.
- Closing the window may keep Electron and the server running.
- Explicit Quit stops the child process and remote access.

## Dependencies

```text
packages/web ───────────────> packages/api <────────────── packages/server
packages/desktop ───────────> packages/api

packages/desktop ──spawns at runtime──> packages/server executable
```

- `packages/api` contains Valibot schemas, the oRPC contract, DTOs, and protocol versions.
- `packages/api` contains no Electron, browser, or Node implementation.
- `packages/web` never imports from `packages/server` or `packages/desktop`.
- `packages/server` runs independently from the Electron process.

## Storage

```text
Pi JSONL         conversation history and Pi session state
Pidex SQLite     projects, runs, action IDs, pairing, and settings
Browser storage  unsent drafts and local UI preferences
```

## Stack

- pnpm workspaces and one `pnpm-lock.yaml`.
- Electron 41 with a supervised Node child process.
- Svelte 5, Vite, and Tailwind CSS 4.
- Valibot for API validation and Effect Schema for persisted-data validation.
- oRPC 2 native RPC for contract-first request/response calls.
- Effect 4 beta for server workflows, dependency injection, and resource lifecycles.
- Node HTTP, `ws`, and Drizzle ORM over `node:sqlite` in `packages/server`.

## Server composition

`packages/server/src/main.ts` is the server composition root. One managed runtime builds
the Pi SDK, metadata, and chat services. SQLite and live chat sessions are scoped resources,
so runtime disposal closes them in dependency order. oRPC handlers and Node callbacks are
the only Promise and callback boundaries.
