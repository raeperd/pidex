# pidex

A macOS Electron app with a Svelte renderer. Choose a project using your existing Pi setup to open a fresh idle conversation. Quit closes the Pi session and its server before Electron exits. This implements [#129](https://github.com/raeperd/pidex/issues/129).

The [v0.0.1 technical spec](docs/v0.0.1-tech-spec.md) defines the remaining milestone.

Use Node.js 24 and pnpm 11.16.0. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` builds and opens the desktop app. Electron main owns the window and native folder dialog; a sandboxed preload exposes only `chooseProject`. The renderer loads the static Svelte build through the local `pidex://app` protocol. Main owns one server child, its per-launch credential, and the exact Pi session path. Main calls the loopback server over Effect RPC/HTTP, then returns a schema-defined snapshot to the renderer. Credentials and server imports stay outside the renderer.

## Verification

```sh
pnpm check
pnpm test --grep '#129'
# Step through the same visible Electron scenario in Playwright Inspector:
pnpm build && pnpm exec playwright test --grep '#129' --debug
```

The acceptance test launches Electron 44.4.3 with Playwright 1.63.0 on macOS, supplies Cancel before the native dialog is invoked, clicks Choose project, checks that the chooser remains available without a conversation, then supplies a temporary project and verifies GPT-4.1, Idle, and an empty conversation. It uses a temporary home and Chromium profile, preserves the real preload and application handlers, and removes the temporary files after closing Electron. The test creates temporary Pi `auth.json` and `settings.json` files. A `models.json` override points OpenAI at a local fixture, and the test asserts zero provider requests. No personal Pi configuration is used. After checking the idle conversation, the test requests Quit and observes Electron exiting with code 0 and the owned server PID disappearing. These assertions run before fallback cleanup.

`test-results/` retains an idle screenshot and a trace captured before Quit. Failures also save an Electron log with the temporary path redacted and a failure screenshot when the window is still open. Open a trace with `pnpm exec playwright show-trace <trace.zip>`. Report #129, the pinned versions, steps, and expected versus actual behavior with the artifacts. macOS CI runs formatting, lint, types, build, and acceptance tests and uploads failure artifacts.

For a manual native-dialog check, run `pnpm dev`, click Choose project, and press Cancel. The chooser should remain available. Select a project on the next attempt, check the configured model and Idle status, then use the application menu to Quit.

## Pi integration

Pi 0.85.1 resolves the configured default model and credentials from its usual files or environment. The server creates a new persistent Pi session; its JSONL file may not exist until the first assistant message. Project instructions, stock tools, retry, and compaction use Pi. External extensions, skills, templates, themes, custom system prompts, and package resources are disabled without changing user settings.

The server gives `DefaultResourceLoader` empty in-memory settings because Pi resolves packages before applying its resource filters. The session itself uses the normal settings manager.

### Editable drafts (#131)

`pnpm test --grep '#131'` runs the dedicated draft scenario. It holds a local provider response while the real Electron composer edits `next task`, attempts keyboard submission, and verifies authenticated RPC busy rejection. Completion preserves the draft without starting another request; pressing Enter on the enabled Send button submits that exact draft.

For visible step-through, run `pnpm build && pnpm exec playwright test --grep '#131' --debug`. The fixture uses temporary Pi configuration and a local OpenAI-compatible provider, with no paid requests. Traces and screenshots are under `test-results/drafts-*`; failures also save redacted Electron logs. Existing draft and busy-rejection behavior needs no production change.

### Setup and provider failures (#138)

`pnpm test --grep '#138'` runs three Electron scenarios with temporary Pi configuration: missing credentials, an unresolved default model, and a held provider response that returns HTTP 503 until Pi exhausts its stock retries. Setup failures show correction steps and disable Send while drafts remain editable. Provider failure returns to Idle with the draft unchanged and exactly four provider attempts. Assertions also exclude the fixture credential and private provider diagnostic from renderer updates and Electron logs.

`pnpm build && pnpm exec playwright test --grep '#138' --debug` opens the same scenarios for visible step-through. Screenshots, traces, and redacted failure logs are under `test-results/failures-*`. No paid requests or retry-setting overrides are used. Pi 0.85.1 owns the three retries with 2/4/8-second backoff. Fix credentials with Pi's `/login` or API-key setup, or save an available default through `/model`, then restart Pidex to reload setup.
