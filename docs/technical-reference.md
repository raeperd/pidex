# Desktop and Mobile-Web Technical Reference

This note fixes the implementation baseline for the Electron desktop app and the host-served mobile web client. It intentionally does not cover a native mobile app, cloud service, relay, generic agent-provider layer, terminal, file explorer, or Git UI.

## Reference snapshots

The comparison was made from fresh default-branch checkouts on July 23, 2026.

| Repository | Ref | Commit | Relevant source |
| --- | --- | --- | --- |
| `pingdotgg/t3code` | `main` | `b41e89eba9cd232cc3257b400fc30972a9b53438` | `package.json`, `pnpm-workspace.yaml`, `apps/{desktop,web,server}`, `packages/{client-runtime,contracts,shared}`, `docs/architecture/{overview,connection-runtime}.md` |
| `getpaseo/paseo` | `main` | `8cf70d10bf438c5f1fb032b7028bba5949ec07a7` | `package.json`, `packages/{app,desktop,server,client,protocol}`, `packages/desktop/src/{main,preload}.ts`, `packages/server/src/server/atomic-file.ts`, `docs/development.md` |

These are design references, not source dependencies. Pidex will not import their packages, copy their protocols, or inherit their compatibility promises.

## Observed stacks and layouts

| Concern | T3 Code snapshot | Paseo snapshot | Pidex consequence |
| --- | --- | --- | --- |
| Workspace | pnpm 11.10; `apps/desktop`, `apps/web`, `apps/server`, `apps/mobile`; shared `client-runtime`, `contracts`, and `shared` packages | npm workspaces; `packages/app`, `desktop`, `server`, `client`, and `protocol` | Use a small pnpm workspace with three apps and one shared API package; keep the other boundaries as internal modules initially. |
| Desktop | Electron 41.5.0, electron-builder 26.15.6, context-isolated preload | Electron 41.2.0, electron-builder 26.8.1, context-isolated preload | Electron 41 is demonstrated by both; exact-pin a compatible patch and preserve the narrow preload boundary. |
| Web UI | React/React DOM 19.2.6, Vite-based DOM app, Tailwind 4, TanStack Router, Zustand | React 19.1, Expo 54, React Native 0.81.5, React Native Web 0.21, Expo Router, Zustand | Keep the DOM/Vite/Tailwind lesson, but implement it with Svelte 5. Expo's value is native reuse, which Pidex does not need. |
| Transport and contracts | Node HTTP/WebSocket host, Effect schemas and runtime, browser-safe contracts and connection runtime | Express, `ws`, Zod 4.4.3, separate protocol and client packages | Use built-in Node HTTP, `ws`, and Zod; keep reconnect and snapshot logic out of Svelte components. |
| Persistence | SQLite, including a `node:sqlite` adapter, plus migrations | Atomic JSON replacement for several small stores | Pidex's durable prompt acceptance and revisions justify `node:sqlite`; retain atomic backups for migrations. |
| Broader dependencies | Effect, Clerk, provider SDKs, SSH/Tailscale packages, Git/terminal/diff tooling, native Expo app | Expo/native modules, daemon/CLI/relay, multiple agent SDKs, ACP, Git/terminal/file tooling | Do not carry these dependency families into the Pi-only desktop/mobile-web scope. |

## What to reuse and what to leave behind

### T3 Code

Useful patterns:

- Separate Electron, DOM web client, host, browser-safe protocol, and client-runtime responsibilities. Pidex does not need each responsibility to be a workspace on day one.
- Treat the DOM client itself as a mobile-web product: T3 Code's web workspace has phone-width layouts, coarse-pointer handling, mobile composer behavior, mobile sidebar/sheet presentation, small-viewport sizing, and safe-area insets.
- One typed HTTP/WebSocket boundary for browser state rather than Electron IPC for ordinary session traffic.
- A context-isolated, sandboxed renderer with a narrow preload bridge for desktop-only capabilities.
- A host-served Vite build and an authoritative connection runtime that distinguishes transport state from cached domain state.
- SQLite for ordered durable host metadata without making transcript storage a second source of truth.

Not applicable to Pidex:

- `apps/mobile` is a separate Expo/React Native application in addition to the responsive web client. Pidex needs the responsive-web pattern from `apps/web`, not this native workspace or its dependency tree.
- Effect, Effect Atom, Vite+, Clerk, SSH, hosted access, relay, provider registries, orchestration, Git, terminal, preview, and checkpoint packages solve a broader product.
- T3 Code may manage server processes and multiple execution environments. Pidex has one in-process host owned by Electron.

### Paseo

Useful patterns:

- Browser-safe `protocol` and `client` workspaces are kept separate from the Node server and Electron main process.
- Electron uses a sandboxed, context-isolated renderer and exposes native operations through a small preload API.
- Desktop packaging explicitly includes the built application and server assets.
- Zod validates data at process and network boundaries, and atomic replacement protects small file-backed records.
- Platform-specific web modules keep browser behavior explicit where a shared UI needs it.

Not applicable to Pidex:

- Paseo shares one Expo/React Native application across web and native targets. Expo, Metro, React Native Web, native navigation, EAS, and native device modules are unnecessary for a browser-only mobile target.
- Paseo's daemon, CLI, relay, multi-provider support, ACP, terminal, Git, file browser, schedules, and native mobile releases are outside Pidex's scope.
- Pidex must not adopt a separately supervised daemon: its host lives in the Electron main process and stops on explicit Quit.

## Chosen stack

Pidex will use strict TypeScript and native ESM in a pnpm workspace with one committed `pnpm-lock.yaml`. Direct third-party production dependencies are exact-pinned; internal packages use the pnpm `workspace:` protocol. The implementation should begin on Node.js 24 LTS, subject to the matched Pi SDK's declared minimum, while the packaged app runs on Electron's embedded Node runtime.

pnpm and Vite solve different problems and are used together:

- pnpm owns workspace discovery, dependency installation, the lockfile, version catalogs, and filtered scripts across apps and packages.
- Vite is the development server and production asset builder inside `apps/web`.
- pnpm's recursive and filtered scripts are sufficient for this workspace size. Do not add Turborepo or Nx initially.

T3 Code layers these tools as follows:

1. `pnpm-workspace.yaml` declares `apps/*`, `packages/*`, `infra/*`, and `scripts`, centralizes shared versions in a catalog, and controls dependency build scripts.
2. Each workspace has its own `package.json` and links internal packages with `workspace:*`. For example, its web app imports `client-runtime`, `contracts`, and `shared`; the server imports the built web app; and the desktop app imports the client and host-facing packages.
3. The web workspace has its own Vite configuration for the browser build, development proxy, tests, Tailwind, and route generation. Vite can resolve linked workspace source, but it does not declare or install those workspaces.
4. T3 Code additionally uses Vite Plus (`vp`) as a repository-wide task runner, formatter, linter, test runner, and packager. Its package configs express build edges such as server after web and desktop after server.
5. Root scripts call `vp run --filter ...` or a custom development runner. pnpm remains the package manager and workspace/lockfile authority beneath Vite Plus.

Pidex should copy the separation, not T3 Code's workspace count or extra orchestration layer. Start with standard Vite in `apps/web` and pnpm commands such as `pnpm --filter @pidex/web dev`, `pnpm -r typecheck`, and dependency-aware filtered builds. Add a workspace or task runner only when an actual reuse, ownership, independent-versioning, build-graph, or caching need appears.

### Desktop and host

- Electron 41, exact-pinned to the latest compatible patch when scaffolding begins.
- `electron-builder` for the macOS artifact and `electron-updater` only for the packaged update flow.
- Electron main owns the in-process host, application lifecycle, folder picker, trust confirmation, Tailscale setup, pairing administration, and the narrow preload bridge.
- Node's built-in `http`, `crypto`, filesystem, and `node:sqlite` modules provide the HTTP server, credentials and digests, file operations, and transactional metadata store. This avoids Express and a native SQLite add-on.
- `ws` provides the host WebSocket server. The browser uses the native `WebSocket` API.
- `qrcode` creates pairing QR payloads. Pidex invokes the installed Tailscale CLI through Node child-process APIs; it does not add a Tailscale SDK.
- The Pi SDK package and version are resolved from the installed Pi CLI during implementation discovery and then saved exactly. No generic provider SDK is included.

Electron's `BrowserWindow` must use `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`. The preload exposes only desktop bootstrap and desktop-only actions. Session queries, commands, snapshots, and events still travel through the same authenticated host protocol used by mobile.

### Shared web client

- Svelte 5 with TypeScript, runes, standard Vite, and the official Svelte Vite plugin. Do not use React, SvelteKit, Expo, React Native Web, Metro, or Vite+ in the first scaffold.
- The initial application is one state-driven control surface, so it does not need SSR, server routes, or a routing dependency. If stable user-facing deep links become a requirement, evaluate a static SvelteKit build separately rather than introducing another server runtime.
- Use Svelte's built-in runes and stores for client-local UI state such as the selected session and connection presentation. Do not add a general state-management library initially. Authoritative projects, sessions, transcript, run state, and settings are replaced from host snapshots rather than treated as local truth.
- Tailwind CSS 4 through `@tailwindcss/vite`, Bits UI primitives, `clsx`, and `tailwind-merge` provide the responsive interface.
- `svelte-exmarkdown` plus `remark-gfm` renders assistant text. Raw HTML stays disabled, remote images are disabled by default, and links use an explicit safe-scheme policy.
- Native `fetch`, `WebSocket`, Clipboard, Web Crypto, and storage APIs where available. No Electron or Node package may enter the browser bundle.

The same production web build is served by the loopback host to Electron and by the verified Tailscale Serve origin to paired mobile browsers. Desktop-only controls are capability-gated by host authorization, not merely hidden by responsive CSS.

### Contracts, persistence, and tests

- Zod 4 schemas are the source for runtime validation and inferred TypeScript protocol types. Network input is parsed at the host boundary and untrusted persisted metadata is parsed when loaded.
- `node:sqlite` stores Pidex metadata, durable action IDs, revisions, pairing verifiers, migrations, and bounded security events. Pi JSONL remains the only transcript store.
- Vitest covers pure units, protocol parsing, host services, migrations, the client connection state machine, and Svelte behavior.
- Svelte Testing Library covers focused browser interactions without asserting component internals.
- Playwright Chromium covers the built responsive web client and packaged Electron flows. Host contract tests use real HTTP and WebSocket transports with the deterministic Pi adapter described in the PRD.

## Proposed repository structure

```text
pidex/
├── apps/
│   ├── desktop/               # Electron main, preload, menu/window lifecycle, packaging
│   ├── web/                   # Svelte/Vite UI used by Electron and mobile browsers
│   │   └── src/lib/client/    # fetch/WebSocket, reconnect, snapshots, action IDs
│   └── server/                # In-process HTTP/WS host, Pi adapter, SQLite, auth, Tailscale
│       └── src/pi/            # Matched-SDK adapter and deterministic test fake
├── packages/
│   └── api/                   # Browser-safe Zod schemas, DTOs, protocol version
├── tests/
│   ├── contract/              # Real host transport and recovery matrix
│   ├── e2e/                   # Responsive web and packaged Electron Playwright tests
│   └── fixtures/              # Pi JSONL, migrations, Tailscale CLI outputs
├── docs/
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

Dependency direction is one-way:

```text
apps/web ───────────────> packages/api
apps/desktop ──> apps/server ──> packages/api
```

`packages/api` must remain browser-safe and contains schemas and inferred types, not server implementations. `apps/server` may use Node APIs and must never be imported by `apps/web`. `apps/desktop` imports the server module, starts it in-process, and packages the `apps/web` production assets. `apps/server` is a workspace for code organization and testing, not a standalone binary or daemon. Its Pi adapter stays behind an internal interface, while the deterministic fake is test-only. The web connection runtime stays under `apps/web/src/lib/client`.

This is the minimum useful package split. Extract `client-runtime`, `pi-adapter`, or persistence packages later only if they gain a second consumer or need independent testing, ownership, or versioning that cannot be maintained cleanly in their app.

## Initial dependency boundary

The first scaffold should include only dependencies needed for the first vertical slice.

| Workspace | Runtime dependencies |
| --- | --- |
| `apps/desktop` | `electron`, `@pidex/server`; Electron packaging remains a development dependency |
| `apps/web` | `svelte`, `svelte-exmarkdown`, `remark-gfm`, `bits-ui`, `clsx`, `tailwind-merge`, `@pidex/api` |
| `apps/server` | exact-matched Pi SDK, `@pidex/api`, `ws`, `qrcode`; prefer Node built-ins for HTTP, crypto, SQLite, and process execution |
| `packages/api` | `zod` |

Build and test dependencies live at the narrowest workspace that uses them. `apps/web` owns Vite, `@sveltejs/vite-plugin-svelte`, Tailwind, `@tailwindcss/vite`, Vitest, and Svelte Testing Library. Root tooling may coordinate TypeScript, Playwright, ESLint, and formatting, but production packages must not depend on test runners or Electron development tooling.

Defer `electron-updater`, richer syntax highlighting, virtualization, and component libraries beyond the named primitives until their corresponding delivery phase needs them. Do not add React, SvelteKit, Expo, React Native, Express, Effect, provider SDKs, hosted-auth SDKs, SSH libraries, relay clients, terminal libraries, Git libraries, or a second transcript database.

## Pre-implementation checks

Before installing the scaffold dependencies:

1. Resolve the installed Pi CLI and its exact matching SDK package/version, then verify that version's public exports, Node engine, and session APIs.
2. Verify the selected Electron build exposes the required `node:sqlite` APIs from its embedded Node runtime. If it does not, select a compatible Electron patch before considering another SQLite package.
3. Record exact third-party versions in the workspace catalog and lockfile; use `workspace:*` only for internal Pidex packages.
4. Prove a minimal packaged Electron window can start the in-process loopback host, load the built web client, authenticate through the one-time preload bootstrap, and shut down cleanly.
5. Prove the same build loads in mobile Chrome over a test HTTPS origin before adding the Pi adapter or broader UI.
