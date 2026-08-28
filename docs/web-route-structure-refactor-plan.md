# Web Route Structure Refactor Plan

## Summary

Refactor the web client from the 1,925-line `src/App.svelte` component into a
SvelteKit route-owned structure. The root layout will remain the single composition
root and persistent application shell. The task route will own transcript, agent
message, tool-call, and composer presentation.

The refactor is structural. It must preserve URLs, API contracts, WebSocket behavior,
draft recovery, task switching, streaming updates, Markdown safety, and responsive UI
behavior. Every commit must compile, typecheck, and pass the relevant tests before the
next commit begins.

This plan is based on repository revision `330d29a`.

## Goals

- Make route ownership visible from the filesystem.
- Replace implementation-oriented Markdown names with agent-message domain names.
- Keep all agent-message files flat and grouped by the `AgentMessage` prefix.
- Keep small one-off UI logic inside the Svelte component that owns it.
- Keep network, connection, navigation, and parsing boundaries independently testable.
- Remove the root-level `App.svelte` after its responsibilities have moved.
- Preserve the persistent shell and current task-navigation behavior.
- Produce small commits that remain buildable and reviewable in isolation.

## Non-goals

- Change the HTTP, oRPC, WebSocket, or `@pidex/api` contracts.
- Redesign the UI or alter existing CSS intentionally.
- Change task URLs or introduce new SvelteKit routes.
- Replace Marked, Shiki, Tailwind, or the current icon package.
- Introduce a general component library or a new workspace package.
- Combine unrelated feature work with this refactor.

## Current state

The current root layout mounts `src/App.svelte` and renders route children after it.
Both `routes/+page.svelte` and `routes/tasks/[taskId]/+page.svelte` contain only a
comment. `App.svelte` reads SvelteKit page state and owns the shell, routing reactions,
project navigation, live task state, transcript, composer, and dialogs.

The agent response renderer is split across `MarkdownNodes.svelte` and
`MarkdownCode.svelte`. Their names expose the current wire format instead of the Pidex
domain. Tests import parsing and highlighting helpers from Svelte module scripts.

Existing verification surfaces include:

- Vitest tests for message parsing, code highlighting, tool calls, navigation, and chat.
- Playwright coverage for deep links, route restoration, safe rich text, and tool calls.
- `svelte-check`, Vite production builds, Oxlint, and Oxfmt checks.

## Target structure

```text
packages/web/src/
├── app.html
├── styles.css
└── routes/
    ├── +layout.ts
    ├── +layout.svelte
    ├── +page.svelte
    ├── _components/
    │   ├── AppShell.svelte
    │   ├── AppShellContext.svelte.ts
    │   ├── AppShellApiClient.ts
    │   ├── AppShellConnection.ts
    │   ├── AppShellConnection.test.ts
    │   ├── ProjectSidebar.svelte
    │   ├── ProjectPicker.svelte
    │   ├── TaskNavigation.svelte
    │   ├── TaskNavigationState.ts
    │   ├── TaskNavigationState.test.ts
    │   └── Icon.svelte
    └── tasks/
        └── [taskId]/
            ├── +page.svelte
            └── _components/
                ├── TaskTranscript.svelte
                ├── UserMessage.svelte
                ├── AgentMessage.svelte
                ├── AgentMessageBody.svelte
                ├── AgentMessageCodeBlock.svelte
                ├── AgentMessageCodeBlock.test.ts
                ├── AgentMessageParser.ts
                ├── AgentMessageParser.test.ts
                ├── ToolCall.svelte
                ├── ToolCall.test.ts
                ├── TaskNotice.svelte
                ├── TaskComposer.svelte
                └── ContextUsageMeter.svelte
```

The exact root helper prefixes may change during extraction if ownership becomes more
specific. The route boundary and flat `AgentMessage*` naming are fixed decisions.

## Ownership rules

### Root layout

`routes/+layout.svelte` is the composition root. It imports global styles, creates the
application shell state, and renders route content through `children`. It must not
contain feature markup beyond the minimal wiring needed to mount `AppShell`.

### Root route components

`routes/_components` owns the persistent shell, project navigation, and state required
by more than one page. `AppShellContext.svelte.ts` is allowed because the layout and
pages are separate Svelte component instances that need the same reactive state.

The context must expose the smallest stable interface needed by route pages. It must
not expose writable state when a named action can express the same operation.

### Task route components

`routes/tasks/[taskId]/+page.svelte` is the task-page composition point. It reads the
task ID from SvelteKit page state or typed page props, consumes shell context, and
assembles the transcript and composer. It must not recreate API or connection clients
on every reactive update.

Files under the task route are private by convention. They must not be imported by the
root layout or unrelated routes after the ownership cutover.

### Embedded and extracted logic

Keep these concerns inside their owning Svelte components:

- DOM references, resizing, scrolling, focus, and keyboard handlers.
- Component-local state and derived presentation values.
- Small formatters used by one component.
- Event handlers that delegate to a context action or boundary object.

Keep these concerns in separate prefixed TypeScript files:

- HTTP and oRPC transport behavior.
- WebSocket lifecycle, reconnect behavior, and event delivery.
- Task snapshot caching and public URL construction.
- Agent-message parsing and URL sanitization.

Import count alone does not decide extraction. A separate file is justified when the
logic is a protocol boundary, a stateful resource, or an algorithm with focused tests.

## Naming map

| Current name                | Target name                                   |
| --------------------------- | --------------------------------------------- |
| `App.svelte`                | `AppShell.svelte` plus route-owned components |
| `MarkdownNodes.svelte`      | `AgentMessageBody.svelte`                     |
| `MarkdownCode.svelte`       | `AgentMessageCodeBlock.svelte`                |
| `parseMarkdown`             | `parseAgentMessage`                           |
| `MarkdownNode`              | `AgentMessageNode`                            |
| `ContextWindowMeter.svelte` | `ContextUsageMeter.svelte`                    |
| `api-client.ts`             | `AppShellApiClient.ts`                        |
| `chat-connection.ts`        | `AppShellConnection.ts`                       |
| `task-navigation.ts`        | `TaskNavigationState.ts`                      |

`ToolCall` remains unchanged because it is already a domain concept in `@pidex/api`.

## Invariants

The following behavior must remain true at every committed step:

- `/` renders the no-active-task experience without a composer.
- `/tasks/[taskId]` remains the only public task URL.
- Deep-linked tasks recover from an initial bootstrap failure without changing URL.
- Browser back, forward, reload, and task switching preserve current behavior.
- Only one live chat connection owns a task session at a time.
- Pending prompts, drafts, configuration drafts, and task snapshots remain isolated.
- Streamed agent text updates remain ordered and batched by animation frame.
- Unsafe links, raw HTML, and remote images remain non-executable.
- Code highlighting remains lazy, bounded, cached, and theme-aware.
- Tool timing and bounded output loading retain their current semantics.
- Desktop and mobile layouts retain their current accessible names and interactions.

## Verification strategy

### Baseline gate

Run the full repository gate before changing code. Record any pre-existing failure in
the implementation PR and do not treat it as introduced by the refactor.

```sh
pnpm check
pnpm test
pnpm build
pnpm test:e2e
```

### Per-commit web gate

Run this gate before creating every implementation commit:

```sh
pnpm exec oxfmt --check packages/web/src packages/web/vite.config.ts
pnpm exec oxlint packages/web/src
pnpm --filter @pidex/web typecheck
pnpm --filter @pidex/web test
pnpm --filter @pidex/web build
```

Run the Svelte autofixer on every changed Svelte component before the web gate:

```sh
npx @sveltejs/mcp svelte-autofixer path/to/changed-component.svelte
```

Do not commit autofixer suggestions blindly. Review them, apply valid changes, and
rerun the component analysis until no relevant issue remains.

### Targeted browser gates

Run focused Chromium tests after message-rendering changes:

```sh
pnpm exec playwright test packages/e2e/app.spec.ts --project=chromium \
  --grep "renders assistant markdown|renders tool calls"
```

Run focused Chromium tests after shell or route-state changes:

```sh
pnpm exec playwright test packages/e2e/app.spec.ts --project=chromium \
  --grep "deep-linked task|no-active-task experience"
```

Run the full Playwright matrix after the route ownership cutover and before the final
commit. This covers the Chromium and mobile projects as well as API tests.

## Commit plan

### Step 0: Capture the baseline

Do not change files in this step.

Actions:

1. Run the baseline gate.
2. Save the current `git status --short` output.
3. Confirm that no unrelated working-tree changes will be included.
4. Record screenshots only if a current UI behavior lacks an assertion.

Exit criteria:

- The baseline result is known.
- Any pre-existing failure is documented.
- The working tree scope is understood.

Commit: none.

### Step 1: Rename and isolate agent-message parsing

First separate the format parser from Svelte rendering. This creates a pure boundary
before components move between routes.

Actions:

1. Create `AgentMessageParser.ts` beside the current renderer.
2. Move parsing, safe-link, code-info, and node types into the parser module.
3. Rename exported Markdown-domain symbols to `AgentMessage*` symbols.
4. Move parser assertions into `AgentMessageParser.test.ts`.
5. Keep rendering and output behavior byte-for-byte equivalent where practical.
6. Update the current renderer to import the parser module.
7. Do not move route ownership in this commit.

Verification:

1. Run the per-commit web gate.
2. Run the targeted message-rendering browser gate.

Exit criteria:

- Parser tests no longer import a `.svelte` file.
- Unsafe URLs, HTML, entities, lists, tables, and code metadata remain covered.
- The application still renders through the existing shell.

Commit:

```text
refactor(web): name agent message parsing by domain
```

### Step 2: Rename the agent-message renderers

Apply flat, semantic names without changing route ownership yet.

Actions:

1. Rename `MarkdownNodes.svelte` to `AgentMessageBody.svelte`.
2. Rename `MarkdownCode.svelte` to `AgentMessageCodeBlock.svelte`.
3. Update recursive self-imports and all imports from `App.svelte`.
4. Rename highlighting tests to `AgentMessageCodeBlock.test.ts`.
5. Rename CSS hooks only when they expose a component contract.
6. Keep the `.markdown` styling hook if changing it would add visual risk.

Verification:

1. Run the autofixer on both renamed Svelte files.
2. Run the per-commit web gate.
3. Run the targeted message-rendering browser gate.

Exit criteria:

- No TypeScript or Svelte symbol uses `MarkdownNode` or `MarkdownCode`.
- Markdown may remain in parser internals, dependency names, or CSS implementation.
- Rendered output and interaction remain unchanged.

Commit:

```text
refactor(web): rename agent message renderers
```

### Step 3: Colocate the persistent shell with the root route

Move the current application owner under the route that owns it. Keep behavior intact
before splitting markup or changing route-page responsibility.

Actions:

1. Create `routes/_components`.
2. Move `App.svelte` to `routes/_components/AppShell.svelte`.
3. Move and rename the API, connection, navigation, icon, and shell meter files.
4. Move their tests with them and update imports.
5. Update `routes/+layout.svelte` to import `AppShell` from `_components`.
6. Preserve the current route-state effects and rendered markup.
7. Keep route page files as placeholders during this commit.

Verification:

1. Run the autofixer on `AppShell.svelte` and `+layout.svelte`.
2. Run the per-commit web gate.
3. Run the targeted shell and route-state browser gate.

Exit criteria:

- No application component or web helper remains directly under `src`.
- The root layout still mounts exactly one persistent shell.
- Deep links, project restoration, and task navigation still work.

Commit:

```text
refactor(web): colocate the app shell with the root route
```

### Step 4: Extract task presentation components

Reduce `AppShell.svelte` without moving task ownership yet. Extract presentation from
the bottom of the component upward so the shell retains state and actions.

Actions:

1. Extract `UserMessage.svelte`.
2. Extract `AgentMessage.svelte` around thinking and agent-response presentation.
3. Extract `TaskNotice.svelte`.
4. Rename and retain `ToolCall.svelte` as a task presentation component.
5. Extract `TaskTranscript.svelte` to choose the item component by item type.
6. Keep scrolling and the transcript DOM reference in `TaskTranscript.svelte`.
7. Pass data and named actions instead of the whole shell state object.
8. Keep message files temporarily beside `AppShell` until route cutover.

Verification:

1. Run the autofixer on every new or changed Svelte component.
2. Run the per-commit web gate.
3. Run both targeted browser gates.

Exit criteria:

- `AppShell` no longer switches directly on transcript item types.
- Transcript output keeps stable keyed iteration by item ID.
- Streaming, tool output expansion, and earlier-message loading still work.

Commit:

```text
refactor(web): extract task transcript presentation
```

### Step 5: Extract the composer and task controls

Move DOM-heavy one-off behavior into the components that own those elements.

Actions:

1. Extract `TaskComposer.svelte` with its textarea reference and resizing logic.
2. Move composer key handling, focus, and local draft input behavior into it.
3. Keep send, stop, queue, and configuration operations as injected actions.
4. Rename `ContextWindowMeter.svelte` to `ContextUsageMeter.svelte`.
5. Keep task dialogs in the smallest component that owns their open state.
6. Extract a component only when it removes a coherent markup and state boundary.
7. Avoid wrappers that merely forward every prop from `AppShell`.

Verification:

1. Run the autofixer on every new or changed Svelte component.
2. Run the per-commit web gate.
3. Run the targeted shell and route-state browser gate.
4. Run the existing draft and configuration tests through the web test command.

Exit criteria:

- Composer focus, resizing, keyboard submission, and stop behavior are unchanged.
- The no-active-task page still renders no prompt or configuration controls.
- `AppShell` owns orchestration rather than task DOM behavior.

Commit:

```text
refactor(web): extract task composer and controls
```

### Step 6: Introduce the shell context boundary

Create the narrow boundary needed for route pages to use persistent shell state. This
step changes internal ownership but must not change public behavior.

Actions:

1. Add `AppShellContext.svelte.ts` using Svelte's typed context API.
2. Define readonly reactive values and named task actions.
3. Create the context once from the root layout or `AppShell` initialization path.
4. Keep API and connection objects private behind context actions.
5. Move route activation and snapshot caching behind the context boundary.
6. Make disposal explicit for connections, timers, and animation frames.
7. Add focused tests for state that can be exercised without rendering markup.

The context contract should group values by responsibility rather than expose the
entire implementation object. Candidate groups are shell state, task state, task
actions, project actions, and dialog actions.

Verification:

1. Run the autofixer on `AppShell.svelte` and any context consumer.
2. Run the per-commit web gate.
3. Run both targeted browser gates.
4. Run the full Chromium `packages/e2e/app.spec.ts` suite.

Exit criteria:

- Only one shell context instance exists for the mounted application.
- Route changes do not leak connections, timers, or pending animation frames.
- UI components no longer receive a monolithic prop object.

Commit:

```text
refactor(web): expose persistent shell state to route pages
```

### Step 7: Transfer UI ownership to route pages

Make SvelteKit pages render their own content and complete the filesystem ownership
change. This is the highest-risk step and requires the full browser matrix.

Actions:

1. Make `routes/+page.svelte` render the no-active-task experience.
2. Make `routes/tasks/[taskId]/+page.svelte` compose the task UI.
3. Move all task presentation files into the task route `_components` directory.
4. Make `AppShell.svelte` render `children` inside the persistent shell frame.
5. Remove task transcript and composer markup from `AppShell.svelte`.
6. Ensure pages consume context instead of importing shell implementation files.
7. Ensure the root route never imports from a descendant route directory.
8. Verify navigation across different task IDs updates the active task correctly.

Verification:

1. Run the autofixer on the layout, pages, shell, and moved components.
2. Run the per-commit web gate.
3. Run `pnpm test:e2e` for the complete Playwright matrix.

Exit criteria:

- Root and task pages contain real route-owned composition.
- Task-private files have no imports from outside the task route.
- The layout renders one shell and one route child tree.
- Desktop, mobile, deep-link, rich-text, and tool-call tests pass.

Commit:

```text
refactor(web): transfer task UI ownership to SvelteKit routes
```

### Step 8: Remove migration leftovers

Clean up only after route ownership and behavior are proven.

Actions:

1. Remove obsolete placeholder comments and unused imports.
2. Remove any forwarding component created only for migration.
3. Remove stale Markdown-domain exports and test names.
4. Search for imports that cross into task-private `_components`.
5. Search for source-root web files that should now be route-owned.
6. Confirm helper files use the prefix of their actual owner.
7. Update architecture documentation if it describes the old root component.

Required searches:

```sh
rg -n "App\.svelte|MarkdownNodes|MarkdownCode|parseMarkdown" packages/web/src
rg -n "tasks/\[taskId\]/_components" packages/web/src/routes --glob '*.{ts,svelte}'
find packages/web/src -maxdepth 1 -type f -print
```

Verification:

1. Run the autofixer on every Svelte file changed during cleanup.
2. Run the per-commit web gate.
3. Run the final repository gate below.

Exit criteria:

- Searches return no obsolete component or symbol names.
- No root component imports task-private implementation files.
- The final tree matches the target ownership rules.

Commit:

```text
refactor(web): remove legacy app structure
```

## Final repository gate

Run these commands on the exact commit intended for review:

```sh
pnpm check
pnpm test
pnpm build
pnpm test:e2e
git status --short
```

The refactor is complete only when all commands pass and `git status --short` contains
no generated or unrelated files.

## Review guidance

Review commits in order. The first two commits should be semantic moves with no route
behavior change. The next three commits establish smaller UI ownership boundaries. The
context and route-cutover commits require close review of lifecycle, cleanup, and
reactive state. The final commit should contain deletions and documentation only.

Reviewers should reject a split when it creates any of these conditions:

- A route-private component is imported by the root shell after the final cutover.
- A leaf component receives most of the shell state as props.
- A connection, timer, or animation frame lacks explicit cleanup.
- A derived presentation value is synchronized through an effect unnecessarily.
- A parser or transport regression is hidden inside a component move.
- A commit mixes structural changes with intentional visual changes.

## Rollback strategy

Each commit must be independently revertible. Before the route cutover, the existing
shell remains the rendering owner, so leaf extraction commits can be reverted alone.
After the cutover, revert Step 7 as a unit if routing, lifecycle, or context behavior
regresses. Do not partially restore imports from task-private components into the root
shell.

No data migration or server rollback is required because the refactor does not alter
API contracts or persisted data.

## Completion checklist

- [ ] The root layout is the only application composition root.
- [ ] The root page owns the no-active-task experience.
- [ ] The dynamic task page owns transcript and composer composition.
- [ ] Agent-message files are flat and share the `AgentMessage` prefix.
- [ ] One-off DOM and event logic lives in its owning Svelte component.
- [ ] Protocol, connection, navigation, and parser logic has focused tests.
- [ ] No obsolete `App.svelte` or Markdown component names remain.
- [ ] Every implementation commit passed the per-commit web gate.
- [ ] Route and message commits passed their targeted browser gates.
- [ ] The route cutover and final commit passed the full Playwright matrix.
- [ ] The final repository gate passes from a clean working tree.
