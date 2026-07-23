# Pidex Architecture

Status: proposed for the first implementation.

## Summary

Pidex is one Electron desktop application with an in-process local server. The server
serves one responsive Svelte web client to both Electron and paired mobile browsers.
Pi runs only on the desktop and remains the source of truth for agent sessions.

## Workspace

```text
apps/
├── desktop/   # Electron main process, preload, lifecycle, and packaging
├── web/       # Svelte, Vite, and Tailwind responsive client
└── server/    # HTTP, WebSocket, Pi, SQLite, authentication, and Tailscale

packages/
└── api/       # Browser-safe Zod schemas and inferred protocol types
```

The web connection code stays in `apps/web/src/lib/client`. The Pi adapter and its
test fake stay in `apps/server/src/pi`. More packages are added only when a second
consumer or independent ownership makes extraction useful.

## Runtime

```text
Electron main ──starts──> in-process server ──controls──> Pi SDK
      │                         │
      └──loads Svelte app───────┼──HTTP/WebSocket──> desktop renderer
                                └──Tailscale HTTPS─> mobile browser
```

- The server binds an operating-system-assigned `127.0.0.1` port.
- Electron imports and starts `apps/server`; there is no daemon or sidecar.
- Desktop and mobile use the same web build and Zod-validated protocol.
- The preload exposes only desktop bootstrap and desktop-only actions.
- Mobile cannot register projects, approve trust, or configure remote access.

## Storage

- Pi JSONL stores conversation history and Pi session state.
- `node:sqlite` stores Pidex projects, runs, action IDs, pairing, and settings.
- Browser storage holds unsent drafts and harmless local UI preferences.

## Stack

- pnpm workspaces with one `pnpm-lock.yaml` file.
- Strict TypeScript and native ESM.
- Electron 41 for the macOS desktop application.
- Svelte 5, Vite, and Tailwind CSS 4 for the responsive web client.
- Zod 4 for shared HTTP, WebSocket, and persisted-data validation.
- Node HTTP, `ws`, and `node:sqlite` in the in-process server.

## Dependency Rules

```text
apps/web ───────────────> packages/api
apps/desktop ──> apps/server ──> packages/api
```

- `packages/api` must remain browser-safe and contain no Node implementation.
- `apps/web` must never import from `apps/server` or `apps/desktop`.
- `apps/server` owns Pi, persistence, authentication, and remote access.
- `apps/desktop` owns Electron APIs and starts or stops the server.
