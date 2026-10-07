Implementation plan; linked issues track delivery progress. Builds on the completed [v0.0.1 baseline](https://github.com/raeperd/pidex/milestone/1). Keep milestones on `0.0.x` until Pidex is usable for daily work. Terms follow the [Pidex glossary](https://github.com/raeperd/pidex/blob/main/docs/glossary.md).

## Problem

The completed v0.0.1 workflow starts fresh in one project per launch. Saved sessions and unsent work need a way back into the UI.

## Intended outcome

Reopen saved sessions, switch projects without quitting, and preserve composer drafts. Keep at most one active Pi session and one run in progress.

## Use cases and acceptance scenarios

Each issue owns one application scenario. Failure variants stay under that issue. Use the linked issue number in test names.

| Issue                                               | Use case                    | Acceptance scenario                                                                                                                                                                                                                                                                         |
| --------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#193](https://github.com/raeperd/pidex/issues/193) | Reopen a recent project     | Open a folder, quit, and relaunch. Select it from recent projects and see its session list without a provider request. A missing folder shows an actionable error and remains in the list.                                                                                                  |
| [#191](https://github.com/raeperd/pidex/issues/191) | Find saved sessions         | Seed two projects with saved Pi sessions. Open one and see only its sessions, newest activity first, with a title or prompt preview and timestamp. Empty and unreadable history have distinct states; one unreadable file does not hide healthy entries.                                    |
| [#194](https://github.com/raeperd/pidex/issues/194) | Resume a session            | Save a session, quit, relaunch, and select it. See its saved transcript; send a follow-up and verify the provider receives earlier context and Pi appends to the same session. Missing or unreadable files show an error without creating replacement history.                              |
| [#192](https://github.com/raeperd/pidex/issues/192) | Start another session       | From an idle session, choose New session. See an empty composer and transcript; send and verify a distinct Pi session while the earlier history stays unchanged.                                                                                                                            |
| [#195](https://github.com/raeperd/pidex/issues/195) | Switch work safely          | Switch between idle sessions and projects; each next prompt uses the selected history, working directory, and instructions from context files. During a run or Stop, switching is disabled and rejected by the owning API. A failed switch never enables Send against the wrong target.     |
| [#196](https://github.com/raeperd/pidex/issues/196) | Keep unsent composer drafts | Type different composer drafts in two sessions, switch between them, close the window and reactivate, then quit and relaunch. Each retains its own text without sending it. Repeat for a new session before its first send; accepted text clears while edits made during submission remain. |

## Implementation decisions

These decisions define the implementation target for the linked issues.

### Session model

A project groups multiple Pidex sessions. Each session is backed by one native Pi session and owns its composer draft and supporting UI metadata. Pi remains authoritative for history and execution. The renderer owns the selected project and session; the server opens a live `AgentSession` only for the duration of a run, so selection never depends on a long-lived server session. Session drafts use local identities until saved Pi history is available. Future panels and their resources belong to the session, as defined in the [glossary](https://github.com/raeperd/pidex/blob/main/docs/glossary.md#session-ownership).

### Ownership

Retain three processes: Electron main, the Svelte renderer, and one owned server child containing Pi. API definitions remain shared code.

| Owner   | Responsibility                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------ |
| Desktop | Native project selection, recent projects, durable draft metadata, the last selected session locator, and server lifetime. |
| Server  | Pi session discovery and history reads, and runs: it opens the target Pi session with project-bound resources for one run, streams its events, and disposes it. It holds no selected session. |
| Web     | Project/session selection and navigation, transcript rendering, editable composer drafts, and visible loading/error states. |
| API     | Validated session locators on every request, transcripts, runs, events, and typed failures across process boundaries.   |

### Navigation and persistence

- Launch into recent projects with a folder-picker option. Opening a project shows its sessions and New session action; resuming is explicit. This replaces the automatic fresh-session behavior in v0.0.1 [#129](https://github.com/raeperd/pidex/issues/129) and [#141](https://github.com/raeperd/pidex/issues/141).
- List saved Pi sessions for the selected canonical project directory, including compatible sessions created by Pi CLI. Use Pi's metadata and history APIs; history stays in Pi JSONL files.
- Store recent paths and composer drafts in a versioned metadata file under Electron's user-data directory, using atomic replacement. Pi owns history; no transcript copies, credentials, or new database.
- Key composer drafts by project/session identity. Show new sessions without saved history as session drafts with local IDs; preserve their composer text when a saved Pi session becomes available.
- Flush composer draft writes before switching, ordinary window close, or Quit. Window close preserves drafts and leaves any active run running; reactivation restores the text without submitting it. On write failure, keep text editable and require explicit discard to leave it. Preserve unreadable metadata and show an error. Abrupt termination may lose pending edits; test these as [#196](https://github.com/raeperd/pidex/issues/196) variants.
- Clear submitted text only after confirmed acceptance. Reconnect reconciles uncertain sends before another submission; restoring a composer draft never sends it.

### Selection and run API

- Retain v0.0.1 transport, authentication, and resource restrictions. Use Effect for application effects and typed errors; plain TypeScript for pure functions and Svelte UI.
- Every request names its target. Transcript reads and Send carry the session locator (project, Pi session ID, and session file once saved); Stop carries the run ID. The server holds no selected session, so Switch, Resume session, and New session change renderer selection and read history without changing server state.
- For each run, the server validates the locator (a recent canonical project, a session file inside that project's Pi session directory, and a matching header ID and cwd). It then opens the Pi session with project-bound resources (working directory, context files, tools), prompts, appends to the same JSONL file, and disposes the session. Measured creation cost is 3–14 ms for histories up to 6.8 MB.
- New session mints the session draft's ID in the renderer. The first Send creates the Pi session with that ID through `SessionManager.create(cwd, sessionDir, { id })`, so the session draft and its saved Pi session share one identity.
- Allow one run at a time. The server rejects Send while a run is active, and the UI disables switching during Running and Stopping. Events carry the run ID and target locator; the renderer applies only events for its selected target.
- A failed transcript read or invalid target shows an actionable error and leaves the previous selection usable; history and composer drafts are preserved.
- Desktop persists the last selected locator. After a crash or relaunch, the renderer reselects it and reads its transcript; interrupted runs are detected from saved history. Stop, window close, and Quit apply to the active run.

## Testing decisions

- Use Playwright Electron on macOS with real preload, server, transport, Pi SDK, and persistence. API tests supplement the six UI scenarios.
- Control provider responses, native dialogs, and network/process failures. Isolate projects, credentials, sessions, and metadata; exercise real files for failure variants.
- Assert UI results, provider context/request counts, session files, composer draft isolation, and process cleanup. Retain v0.0.1 regressions, updating the launch expectations changed here.
- After adding tests, use their issue numbers with `pnpm test --grep '#194'`. Step through visibly with `pnpm build && pnpm exec playwright test --grep '#194' --debug`.
- Record fixtures, reproduction steps, and expected/actual results; save failure traces, screenshots, and redacted logs in `test-results/`. Consider WebdriverIO for required capabilities Playwright Electron lacks.
- Release after all scenarios/regressions, `pnpm check`, and `pnpm test` pass in macOS CI. Record a real-Pi smoke run across two projects, relaunch, and composer drafts; keep paid requests outside CI.

## Implementation workflow

Implementation order: [#191](https://github.com/raeperd/pidex/issues/191) → ([#192](https://github.com/raeperd/pidex/issues/192), [#193](https://github.com/raeperd/pidex/issues/193), [#194](https://github.com/raeperd/pidex/issues/194) in parallel) → [#195](https://github.com/raeperd/pidex/issues/195) → [#196](https://github.com/raeperd/pidex/issues/196).

Complete #191 first to establish session listing and validated identities. Then #192–#194 can proceed in parallel; coordinate the session-replacement API and shared-file ownership between #192 and #194. #195 waits for all three to provide new/resume operations and project navigation. #196 follows #195 to preserve drafts across navigation and application lifecycle events. Keep this order synchronized with GitHub blocking relationships.

#191–#194 and the runtime part of #195 ([#211](https://github.com/raeperd/pidex/pull/211)) landed with server-side session replacement. Migrate in one stack before #196: per-run sessions in the server, keeping existing operations green → renderer-owned selection that completes #195 → removal of server session replacement and the recovery-locator acknowledgment.

- Implement the linked issues in dependency order under the [v0.0.2 milestone](https://github.com/raeperd/pidex/milestone/2). Keep one use case mapped to one issue and acceptance scenario; GitHub blocking relationships record prerequisites.
- Follow [pidex-implement-issue](https://github.com/raeperd/pidex/blob/main/.agents/skills/pidex-implement-issue/SKILL.md): behavioral failure → minimal implementation → refactor green → visible verification.
- Split or stack cohesive PRs as needed. Complete CI, Codex, and independent review through the composed skill; acceptance coverage determines release readiness.

## Out of scope

- Concurrent sessions or agents, managed worktrees, and simultaneous editing of one session by Pidex and another client.
- Automatic session continuation, automatic server restart, remote access, and independent daemons.
- Transferring or recovering composer drafts when missing Pi history causes crash recovery to create a fresh session. Retain the v0.0.1 recovery behavior for this case.
- Model/thinking controls, steering/queues, attachments, login UI, and external customization.
- Session search, rename, deletion, archival, branching, installers/signing, and Windows/Linux acceptance.
- File-tree panels, browser tabs, integrated terminals, and their resource-lifecycle policies.

## References

- [Pi SDK at the current 0.85.1 dependency](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/sdk.md): verify discovery, per-run session creation, and persistence against the installed version before implementation, following [pidex-pi-sdk](https://github.com/raeperd/pidex/blob/main/.agents/skills/pidex-pi-sdk/SKILL.md).
- [T3 Code thread workflow](https://github.com/pingdotgg/t3code/blob/d6f291303ddc0c9a14f570266a4d9eff6d431593/docs/user/thread-sidebar.md) and [composer draft restoration tests](https://github.com/pingdotgg/t3code/blob/d6f291303ddc0c9a14f570266a4d9eff6d431593/apps/web/src/composerDraftStore.test.ts#L203): references for navigation and composer draft isolation; Pidex retains Pi-owned history.

