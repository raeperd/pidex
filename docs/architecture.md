# Pidex Architecture

## Repository

```text
apps/
├── desktop/   # Electron shell and server process supervisor
├── web/       # Responsive Svelte, Vite, and Tailwind client
└── server/    # HTTP, WebSocket, Pi, SQLite, auth, and Tailscale

packages/
└── api/       # Browser-safe Zod schemas and inferred types
```

- Keep the web connection code inside `apps/web`.
- Keep the Pi adapter inside `apps/server`.
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
apps/web ───────────────> packages/api <────────────── apps/server
apps/desktop ───────────> packages/api

apps/desktop ──spawns at runtime──> apps/server executable
```

- `packages/api` contains Zod schemas, DTOs, and protocol versions.
- `packages/api` contains no Electron, browser, or Node implementation.
- `apps/web` never imports from `apps/server` or `apps/desktop`.
- `apps/server` runs independently from the Electron process.

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
- Zod 4 for API and persisted-data validation.
- Node HTTP, `ws`, and `node:sqlite` in `apps/server`.
