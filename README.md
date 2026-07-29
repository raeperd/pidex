<p align="center">
  <img src="apps/desktop/assets/icon.png" width="96" alt="pidex icon">
</p>

# pidex

**Use Pi from a focused desktop or browser interface.**

pidex works with the Pi you already use. Pick a project, start or resume a task, follow Pi's work, and keep your credentials and conversations on your machine.

- **Your Pi setup:** Use your existing login, models, tools, project context, and saved conversations.
- **Tasks by project:** Find recent work quickly and return to the task you left open.
- **Isolated worktree tasks:** Start a task on a fresh `pidex/*` branch without changing the project's current checkout.
- **Work in view:** Follow streaming replies and tool activity, change the model or thinking level, copy a response, or stop a run.
- **Reliable reconnects:** Pi keeps working if the browser disconnects. pidex restores the latest state when you return.
- **Local by default:** pidex listens only on `127.0.0.1`, with no account, telemetry, public sharing, or transcript database.

## Get started

You need Node.js 24 LTS, pnpm `11.16.0`, and a working Pi login.

```sh
pnpm install
pnpm exec playwright install chromium
pnpm dev
```

Open the URL printed in the terminal. pidex starts at `http://127.0.0.1:4783` and uses the next free port when needed.

If no models appear, run `pi`, enter `/login`, then restart pidex.

## Use pidex

1. Add a project from the task sidebar.
2. Start a task in the current checkout, create one in an isolated worktree, or open a recent task.
3. Choose a model and thinking level, then send a prompt.
4. Follow the response and tool activity. You can leave and reconnect without stopping Pi.

pidex records a prompt before sending it to Pi, so reconnecting cannot accidentally repeat accepted work. If pidex stops during a run, it asks you to review and acknowledge the uncertain result before continuing.

## Open pidex from another device

You can use Tailscale Serve to reach pidex privately from another device on your Tailnet.

Start pidex, then run:

```sh
tailscale serve --bg http://127.0.0.1:4783
tailscale serve status
```

Use the private HTTPS URL shown by Tailscale. Both devices must be on the intended Tailnet, and the computer running pidex must stay awake and connected. Restrict access with Tailscale ACLs or grants. Do not enable Funnel.

pidex does not configure or verify Tailscale for you. If pidex uses another port, update the Serve command to match it.

## Privacy and safety

Pi remains the source of truth for models, tools, authentication, and conversation files. pidex stores only the metadata and run state needed to operate the interface; it does not copy credentials or transcripts into its database.

Project resources load only after Pi trusts the project. Assistant Markdown is sanitized, raw HTML and remote images are disabled, and requests from unapproved hosts or cross-site origins are rejected.

**Pi has no built-in sandbox.** Read-only mode limits the tools available to the model, but Pi extensions still run with your user permissions. Use a VM, container, or OS sandbox for untrusted or unattended work.

## Configuration

| Variable               | Purpose                                                                | Default        |
| ---------------------- | ---------------------------------------------------------------------- | -------------- |
| `PORT`                 | Server port from 1024 to 65535                                         | `4783`         |
| `WORKSPACE_ROOTS`      | Allowed workspace roots, separated with your platform's path delimiter | Home directory |
| `PIDEX_PROJECT_ROOTS`  | Folders searched by the project picker                                 | `~/Projects`   |
| `PIDEX_STATE_DIR`      | Location of pidex metadata and managed Git worktrees                   | Platform data  |
| `PIDEX_TAILSCALE_HOST` | One allowed Tailscale Serve hostname                                   | Disabled       |

Projects discovered through `PIDEX_PROJECT_ROOTS` must also be inside `WORKSPACE_ROOTS`. Production startup stops with an error if its port is busy.

The desktop app stores metadata and managed worktrees under Electron's platform-native `userData` directory, in a dedicated `state` subdirectory. On macOS the database is normally `~/Library/Application Support/pidex/state/pidex.sqlite`. A standalone server defaults to `~/.pidex`; `PIDEX_STATE_DIR` overrides either location.

## Troubleshooting

- **No models:** Run `pi`, enter `/login`, and restart pidex.
- **Project rejected:** Add its canonical parent directory to `WORKSPACE_ROOTS`.
- **Project resources skipped:** Review and save the project's trust decision in Pi.
- **Run interrupted:** Review the Pi conversation, then acknowledge the uncertain run.
- **Port already in use:** Stop the other listener or choose another `PORT`.
- **Desktop app does not start:** Run `pnpm build` and check for a port conflict.

## Development

```sh
pnpm typecheck      # Check types
pnpm test           # Run deterministic tests; no paid model calls
pnpm test:e2e       # Run Playwright tests in Chromium
pnpm build          # Build all packages
pnpm package:desktop # Build an unsigned macOS app in apps/desktop/release
pnpm start          # Run the built browser app and server
pnpm start:desktop  # Run the built desktop app
```

Tests live beside the code they exercise and use real local dependencies when they are fast and
deterministic. Outside-in Playwright workflows live in `e2e/`, grouped by product behavior; shared
browser helpers stay in `e2e/support.ts`.

The packaged app is ad-hoc signed for local development, so it does not require an Apple
Developer account. It is not notarized or intended for distribution.

To inspect the Pi SDK without sending a model request:

```sh
pnpm build
pnpm smoke:pi -- /absolute/project/path
```

Add `--prompt "Reply with OK"` only when you intend to make a paid model request.

See [Architecture](docs/architecture.md) for the runtime, package boundaries, storage, and stack.
