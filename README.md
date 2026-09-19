# pidex

A macOS Electron app with a Svelte renderer. This first layer of [#129](https://github.com/raeperd/pidex/issues/129) opens the project picker and keeps the chooser available after Cancel. Pi startup and owned backend shutdown follow in dependent PRs.

The [v0.0.1 technical spec](docs/v0.0.1-tech-spec.md) defines the remaining milestone.

Use Node.js 24 and pnpm 11.16.0. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` builds and opens the desktop app. Electron main owns the window and native folder dialog; a sandboxed preload exposes only `chooseProject`. The renderer loads the static Svelte build through the local `pidex://app` protocol.

## Verification

```sh
pnpm check
pnpm test --grep '#129'
# Step through the same visible Electron scenario in Playwright Inspector:
pnpm build && pnpm exec playwright test --grep '#129' --debug
```

The acceptance test launches Electron 44.4.3 with Playwright 1.63.0 on macOS, supplies Cancel before the native dialog is invoked, clicks Choose project, and checks that the chooser remains available without a conversation. It uses a temporary home and Chromium profile, preserves the real preload and application handlers, and removes the temporary files after closing Electron. No personal Pi configuration is used.

On failure, `test-results/` contains a screenshot, trace, and Electron log with the temporary path redacted. Open a trace with `pnpm exec playwright show-trace <trace.zip>`. Report #129, the pinned versions, steps, and expected versus actual behavior with the artifacts. macOS CI runs formatting, lint, types, build, and acceptance tests and uploads failure artifacts.

For a manual native-dialog check, run `pnpm dev`, click Choose project, and press Cancel. The chooser should remain available.
