# pidex

A macOS Electron app with a Svelte renderer. Choose a project using your existing Pi setup to open a fresh idle conversation. Quit closes the Pi session and its server before Electron exits.

Open the [v0.0.2 HTML design](docs/v0.0.2-design.html) in a browser to explore recent projects, saved sessions, and composer drafts. The standalone prototype includes 14 preview states and design references. It uses sample data and makes no agent requests.

Use Node.js 24 and pnpm 11.16.0. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` builds and opens the desktop app. Electron main owns the window and native folder dialog; a sandboxed preload exposes only `chooseProject`. The renderer loads the static Svelte build through the local `pidex://app` protocol. Main owns one server child, its per-launch credential, and the exact Pi session path. Main calls the loopback server over Effect RPC/HTTP, then returns a schema-defined snapshot to the renderer. Credentials and server imports stay outside the renderer.

## Verification

```sh
pnpm check
pnpm test tests/project-selection.spec.ts
# Step through the same visible Electron scenario in Playwright Inspector:
pnpm build && pnpm exec playwright test tests/project-selection.spec.ts --debug
```

The acceptance test launches Electron 44.4.3 with Playwright 1.63.0 on macOS, supplies Cancel before the native dialog is invoked, clicks Choose project, checks that the chooser remains available without a conversation, then supplies a temporary project and verifies GPT-5.6 Luna, Idle, and an empty conversation. It uses a temporary home and Chromium profile, preserves the real preload and application handlers, and removes the temporary files after closing Electron. The test creates temporary Pi `auth.json` and `settings.json` files. A `models.json` override points OpenAI at a local fixture, and the test asserts zero provider requests. No personal Pi configuration is used. After checking the idle conversation, the test requests Quit and observes Electron exiting with code 0 and the owned server PID disappearing. These assertions run before fallback cleanup.

`test-results/` retains an idle screenshot and a trace captured before Quit. Failures also save an Electron log with the temporary path redacted and a failure screenshot when the window is still open. Open a trace with `pnpm exec playwright show-trace <trace.zip>`. Report the pinned versions, steps, and expected versus actual behavior with the artifacts. macOS CI runs formatting, lint, types, build, and acceptance tests and uploads failure artifacts.

For a manual native-dialog check, run `pnpm dev`, click Choose project, and press Cancel. The chooser should remain available. Select a project on the next attempt, check the configured model and Idle status, then use the application menu to Quit.

## Pi integration

Pi 0.85.1 resolves the configured default model and credentials from its usual files or environment. The server creates a new persistent Pi session; its JSONL file may not exist until the first assistant message. Project instructions, stock tools, retry, and compaction use Pi. External extensions, skills, templates, themes, custom system prompts, and package resources are disabled without changing user settings.

The server gives `DefaultResourceLoader` empty in-memory settings because Pi resolves packages before applying its resource filters. The session itself uses the normal settings manager.

### Editable drafts

`pnpm test tests/drafts.spec.ts` runs the dedicated draft scenario. It holds a local provider response while the real Electron composer edits `next task`, attempts keyboard submission, and verifies authenticated RPC busy rejection. Completion preserves the draft without starting another request; pressing Enter on the enabled Send button submits that exact draft.

For visible step-through, run `pnpm build && pnpm exec playwright test tests/drafts.spec.ts --debug`. The fixture uses temporary Pi configuration and a local OpenAI-compatible provider, with no paid requests. Traces and screenshots are under `test-results/drafts-*`; failures also save redacted Electron logs. Existing draft and busy-rejection behavior needs no production change.

### Setup and provider failures

`pnpm test tests/failures.spec.ts` runs Electron scenarios with temporary Pi configuration: missing credentials, an unresolved default model, exhausted provider retries, context overflow, and recovery through retry or compaction. Setup failures show correction steps and disable Send while drafts remain editable. Exhausted HTTP 503 retries return to Idle with the draft unchanged and exactly four provider attempts. Assertions also exclude the fixture credential and private provider diagnostic from renderer updates and Electron logs.

The server retains each run's SDK failure even when Pi removes the failed reply from its context. A successful assistant retry clears that failure; successful compaction alone does not. Regression scenarios cover overflow with nothing to compact, failed compaction, successful compact-and-retry, repeated overflow, and Stop during compaction. Terminal failures show guidance at Idle; recovery and cancellation leave no stale error.

`pnpm build && pnpm exec playwright test tests/failures.spec.ts --debug` opens the same scenarios for visible step-through. Screenshots, traces, and redacted failure logs are under `test-results/failures-*`. No paid requests or retry-setting overrides are used. Pi 0.85.1 owns the three retries with 2/4/8-second backoff. Fix credentials with Pi's `/login` or API-key setup, or save an available default through `/model`, then restart Pidex to reload setup.

## Backend recovery

After a backend crash, click Restart to load the exact saved conversation. An interrupted run stays stopped until you send another prompt. Recovery does not make a provider request; unfinished output may not have been saved by Pi. The recovery locator lives only in Electron main memory.

Run `pnpm test tests/recovery.spec.ts`, or `pnpm build && pnpm exec playwright test tests/recovery.spec.ts --debug` for visible step-through. The isolated lifecycle fixture supplies temporary credentials, project, history, and controlled provider replies. It kills the actual owned child after a saved turn and during a held response, checks main survival and one replacement, compares JSONL bytes before/after recovery, then sends manually. Traces, failure screenshots, and redacted Electron logs are in `test-results/`.

## Stop and continue

Stop targets the observed `runId` through authenticated RPC. Snapshots and state updates carry a nullable `runId` and `idle`, `running`, or `stopping` status. Stop stays pending until Pi acknowledges cancellation and the prompt finishes. Duplicate Stops wait for that cancellation; stale IDs do nothing. The same Pi session accepts the next prompt. Available output, saved history, and tool edits remain; interrupted tokens may not have been saved.

```sh
pnpm test tests/stop-run.spec.ts
pnpm build && pnpm exec playwright test tests/stop-run.spec.ts --debug
```

The isolated Electron test uses a temporary project, Pi configuration, and local OpenAI response server. A test-only Node import holds the provider response's cancellation error until the fixture releases it. It leaves Pi, stock tools, application handlers, preload, and authenticated RPC unchanged. The test checks Stopping, editable drafts, disabled Send, preserved history and `note.txt`, then continuation in the same session. A second isolated variant stops stock preflight compaction and verifies its pending turn cannot escape cancellation. Repeated authenticated Stop calls wait for acknowledgment; calls targeting the old run cannot stop the later run. `test-results/stop-run-*/` contains `stopping.png` and `trace.zip`; failures also retain a screenshot and redacted Electron log.

## Quit during work

Quit reads the backend's current run before opening a native confirmation with Cancel as the default. Cancel leaves that run alive. Confirm waits for the same run-targeted cancellation used by Stop, then closes the RPC connection, disposes the owned backend, and exits Electron. Repeated Quit requests share the pending shutdown. An unavailable or failed run lookup requires confirmation because the last observed Idle state may be stale. If RPC is unavailable, confirmed Quit sends SIGTERM to the owned backend and waits for its Pi cancellation finalizer and process exit.

```sh
pnpm test tests/quit-run.spec.ts
pnpm build && pnpm exec playwright test tests/quit-run.spec.ts --debug
```

The isolated tests cover connected RPC, a lost connection, and a connection lost before the run is observed. They supply native dialog results before Quit, release `Still working` after Cancel, and hold provider cancellation acknowledgment after Confirm. Each checks both PIDs while acknowledgment is held, then observes exit and preserved history/file edits from outside Electron. None makes UI assertions after exit. Artifacts are under `test-results/quit-run-*/`. For a manual native dialog check, start a run in a disposable project with `pnpm dev`, choose Quit from the application menu, cancel once, then confirm the next Quit.

For missing or unreadable history, run `pnpm test tests/recovery.spec.ts` or `pnpm build && pnpm exec playwright test tests/recovery.spec.ts --debug`. Missing history starts a distinct empty conversation with an explanation, without selecting another saved session. Unreadable history reports the path and permission error and stays untouched; restore access and click Restart. Tests remove the exact file, interrupt the first turn before persistence, and deny the replacement child's read using real filesystem permissions. Cleanup restores permissions and compares the original bytes.

Full Quit discards the in-memory recovery locator. Relaunching and choosing the same project starts a new conversation; earlier Pi JSONL files remain unchanged. Run `pnpm test tests/relaunch.spec.ts` or `pnpm build && pnpm exec playwright test tests/relaunch.spec.ts --debug`. The test observes the original Electron/backend PIDs exit before launching again in the same isolated home, verifies an empty conversation, and completes a new turn with a distinct saved session identity. `process-observations.json` records both process pairs and session IDs beside the traces in `test-results/`.
