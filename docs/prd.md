# Pidex Product Requirements Document

## Problem Statement

Pi users start Pi sessions in Pidex on their desktop. When away, they have no simple way to check a long-running task, stop it, or send the next prompt from a phone or tablet. They need network access to the same Pidex-managed session while Pi, their code, credentials, and session data stay on the desktop.

That creates four problems:

1. Connecting a phone or tablet to Pi is hard to set up safely. Current options can require an open internet port, a cloud service, or a separate server.
2. After a network break, a screen can miss updates or show old information. A retry can send the same prompt twice, and a lost connection can stop work that should keep running.
3. Tools made for many coding agents add accounts and features for other agents, teams, and running agents on other machines. Pi users do not need them.
4. Apps that copy Pi's core behavior or read only part of a Pi session can behave differently from Pi. Tool use, model and thinking settings, compaction, credentials, project instructions, and saved history may not match Pidex's supported Pi profile.

The target user already uses Pi as their only coding agent and works mostly from a personal desktop. They sometimes need to check or control the same session from a phone or tablet over a private network. They do not want a cloud agent, a hosted Pidex service, or a separate server to maintain.

## Solution

Pidex will be a local-first, Pi-only app for using the same Pidex-managed Pi sessions from two places:

- an Electron desktop app that runs the local host and handles project, trust, and remote-access setup; and
- a responsive mobile web app served by that host and opened in a phone or tablet browser.

The host runs on the desktop, is the only place Pi executes, and owns every session's Pi state. Desktop and mobile use the same host protocol and render host-authored settings, transcripts, and run states. Each client may choose which session to view without changing another client's view. From the shared interface, a user can create and reopen Pidex-managed sessions, copy a full assistant response, send prompts, and follow or stop runs. Closing a client or losing its connection does not stop Pi. After reconnecting, the client receives the current host state, and retrying a prompt cannot start the same work twice. When the host is unavailable, mobile shows an offline state instead of implying that session data was lost.

Only the desktop can register projects, approve project trust, configure remote access, or review and revoke paired devices. Mobile can use sessions only in desktop-approved projects and cannot browse or expand host filesystem access.

Pidex will embed and pin Pi's Node.js SDK. Pi remains responsible for its agent loop, built-in tools, models, credentials, supported settings and project instructions, compaction, and JSONL session history. Pidex does not copy Pi or add another agent-provider layer; it adds the local host, shared interface, and small amount of metadata needed for projects, pairing, and continuity. The proof of concept and v1 intentionally support a limited Pi compatibility profile. Broader compatibility with Pi customization is future work.

Tailscale will be the only remote-access method in v1, and remote access will be off by default. The host stays bound to loopback. When the user enables remote access, the desktop configures and verifies a Tailscale Serve HTTPS route and reports setup failures. It then displays a short-lived, single-use QR code or pairing link. Pairing gives each browser its own revocable Pidex credential. Tailscale provides the private route and HTTPS transport, while Pidex controls which paired devices may use the app.

Closing the desktop window leaves the host running in the background while a Pi run is active or remote access is enabled. Explicit Quit stops the host and remote access. Mobile access requires the desktop to remain awake, running Pidex, and connected to Tailscale.

Pidex will not use a cloud account, hosted Pidex service, public relay, native mobile app, SSH bootstrap, LAN access, separate server to maintain, or generic agent-provider layer.

## User Stories

Pidex has one target user: a Pi developer who moves between desktop and mobile. These stories focus on the experience Pidex adds around Pi; Pi provides the standard coding-agent capabilities.

1. As a desktop user, I want to register project folders and approve project trust, so that Pi works in the intended directory without mobile expanding filesystem access.
2. As a Pidex user, I want to create and reopen Pidex-managed Pi sessions within projects, so that I can continue work started in Pidex.
3. As a Pidex user, I want desktop and mobile to show the same host-authored state for a session, so that I can switch devices without losing context.
4. As a Pidex user, I want to copy the full text of an assistant response with one action, so that I can reuse Pi's output without selecting it manually.
5. As a desktop user, I want active runs and remote access to continue when I close the window, with an explicit Quit action to stop the host, so that I do not interrupt work accidentally.
6. As a desktop user, I want remote access off by default and one place to enable or disable verified Tailscale access with clear setup errors, so that remote access has one private and understandable path.
7. As a desktop user, I want to pair a browser with a QR code or link and review or revoke each paired device, so that I control which devices can use Pidex.
8. As a mobile user, I want to open Pidex in my browser and use sessions only in desktop-approved projects, so that I can access Pi without a native app or host filesystem controls.
9. As a mobile user, I want to send prompts and follow or stop runs, so that I can control Pi away from my desktop.
10. As a mobile user, I want Pi to continue when my phone disconnects and show the current session when I reconnect, so that locking my phone or changing networks does not interrupt work.
11. As a mobile user, I want a clear offline screen when the desktop host is unavailable, so that loss of access is not confused with loss of data.

## Implementation Decisions

### Product scope and terminology

- Pidex is a Pi-only client and local host, not a generic agent platform.
- A **host** is the single Pidex runtime owned by the Electron app. A **client** is its desktop renderer or one paired mobile browser.
- A **project** is a desktop-registered directory, not necessarily a Git repository root. A Git worktree may be registered as its own project.
- A **session** is one Pi session created and managed by Pidex and bound to one project. V1 does not attach to sessions started by the standalone Pi application.
- A **run** is one accepted prompt and all Pi work it causes. It has a stable host-issued run ID. Pi may emit several lower-level turns during one Pidex run.
- The first release targets macOS with TypeScript and Electron. Windows and Linux packaging are deferred; the PRD does not require a particular web UI framework.

### Application architecture

- The Electron main process runs one in-process host and its HTTP/WebSocket server. Pidex does not install a daemon, sidecar, or separate server.
- The host binds an OS-assigned `127.0.0.1` port. Tailscale Serve is the only supported remote bridge to it.
- Desktop and mobile load the same responsive web client and use the same typed host protocol. The renderer receives no direct filesystem, Pi, credential, or Tailscale API.
- The host is the authority for Pi execution, project access, persistence, authentication, concurrency, and ordered state. Clients submit commands and render host state; they do not coordinate Pi work or resolve conflicts between themselves. Desktop authentication begins with a short-lived, one-time secret delivered through a context-isolated preload bridge; loopback alone is not trusted.
- The Pi adapter stays thin and Pi-specific. It is a test seam around the pinned SDK, not an abstraction for other agents.

### Pi integration

- Pidex embeds and pins Pi's Node.js SDK. Pi remains responsible for the agent loop, built-in tools, models, credentials, supported settings and context, events, abort, compaction, and JSONL persistence.
- Each open Pidex session has its own Pi runtime. Idle runtimes may be disposed and later reopened from the same Pi JSONL file.
- Pi JSONL is the source of truth for conversation history. Pidex keeps only the metadata needed to find and operate its sessions.
- Managed sessions live under a Pidex-owned session root. Pidex rejects resolved session files outside that root and does not import or mutate standalone Pi sessions in v1.
- Pi resolves models and the user's existing credentials. Pidex neither implements provider login nor copies or exposes credential values; it only reports useful credential diagnostics.
- Pidex loads Pi's context files, project settings, and skills. As a deliberate proof-of-concept and v1 limit, extensions, extension-provided providers, prompt templates, themes, and keybindings remain disabled, including when supplied by packages. Supported resource errors and ignored resource types are visible to the user. Later releases may expand this compatibility profile without adding support for other coding agents.
- Pidex uses Pi's project-resource detection and trust store. Existing decisions are honored; new or changed trust requires desktop confirmation before protected resources load. Mobile cannot change trust.
- Project trust controls resource loading only. It is not a sandbox or tool-permission system, and Pi still runs with the desktop user's operating-system permissions.
- One host-owned Pi service layer accesses Pi credentials, settings, trust, and model state for all Pidex sessions. Desktop and mobile clients never read or write those files directly; Pidex relies on the pinned Pi SDK for their access and concurrency behavior.

### Project and session behavior

- Projects are added with the desktop folder picker, stored by canonical path, and revalidated before a runtime starts. Missing or changed targets become unavailable rather than inheriting stale trust.
- Desktop and mobile may create or reopen Pidex-managed sessions, but mobile is limited to projects already registered, available, and trusted on desktop. Session selection is local to each client; the selected session's contents and run state always come from the host.
- The host and its Pi runtimes own concurrency. A session accepts one run at a time, while other sessions may run concurrently. Clients do not schedule runs locally. Stop targets a run ID, is idempotent, and must not stop a newer run.
- Disconnecting a client does not stop a run or dispose a session. Reopening a disposed session restores its transcript and effective settings before accepting another prompt.

### Client experience

- The shared client provides client-local project and session navigation, host-authored transcript and tool activity, a prompt input, Stop, usage, connection state, and the session's effective settings.
- Only desktop can register projects, approve trust, change settings, configure remote access, manage paired clients, or quit the host. Mobile cannot browse or expand host filesystem access.
- Each assistant response has a one-action control that copies its full text on desktop and mobile and visibly reports clipboard failure.
- Large tool results are collapsed and fetched in bounded chunks. Unsupported or binary content is shown as bounded metadata rather than sent unbounded through WebSocket.
- While a run is active, the prompt input cannot submit another prompt. V1 does not expose Pi steering or follow-up queues.
- When the host is unavailable, mobile shows an explicit offline state and retry action. It does not show missing host data as an empty project or queue mutations offline.

### Protocol and continuity

- HTTP serves the web client, public host descriptor, pairing exchange, authenticated bounded resources, and short-lived WebSocket tickets. WebSocket carries commands, snapshots, and live events.
- The descriptor and WebSocket hello negotiate a schema-validated protocol version. Desktop, host, and host-served mobile client ship together.
- Every mutation carries an authenticated client ID and client-generated action ID. Session mutations also carry the session ID and, where conflicts matter, the expected durable revision. Stop carries the exact run ID.
- Before one Pi prompt call, the host durably records the action ID, request digest, target session, and run ID. Retrying the same action returns its recorded outcome; reusing it with different content is rejected.
- A prompt outcome distinguishes rejection before acceptance from running, completed, cancelled, failed, and interrupted/unknown. Transport loss does not imply rejection. An ambiguous action is never invoked again automatically and must be resolved or acknowledged before another prompt is accepted.
- Each session has a durable revision. Initial connection and reconnect begin with an authoritative snapshot; bounded replay is allowed only when the host can prove the range is complete.
- Live events are an optimization. After gaps or restart, clients converge from Pi JSONL and host state. The host never invents completion for a crash-interrupted run.
- The client stores drafts locally, scoped by host ID and session ID. Drafts and interrupted actions are never submitted automatically after reconnect, and state from one host is not merged into another.

### Tailscale-only remote access

- Remote access is off by default, with no LAN or public-network fallback. The desktop requires a supported Tailscale CLI, a logged-in client, MagicDNS, and HTTPS Serve before enabling it.
- The host remains on loopback. Pidex adds only its exact Serve route after confirming the address and path are unused, reads it back, and records enough information to prove ownership. It never resets or replaces unrelated Serve configuration.
- On later launches, Pidex updates only a still-owned route for its current loopback port. If ownership cannot be proved, remote access stays disabled and the desktop gives remediation guidance.
- Before presenting pairing, Pidex probes the final MagicDNS HTTPS URL and verifies the expected host ID and protocol version.
- Pairing offers a QR code or copyable link. Its short-lived, single-use secret is placed in the URL fragment so it is absent from the initial request, access log, and referrer.
- Disabling remote access rejects new remote authentication, closes remote WebSockets, and removes the route only when it still matches the stored Pidex-owned mapping. Otherwise Pidex leaves Tailscale configuration untouched and reports manual cleanup.
- Tailscale supplies private routing and HTTPS, not Pidex authorization. The desktop must remain awake and running; v1 has no Funnel, public tunnel, relay, SSH bootstrap, remote launch, or Wake-on-LAN.

### Authentication and security

- The host has a stable random ID and a signing secret. Pidex-owned persistent secrets use Keychain-backed storage on macOS with no plaintext fallback; remote authentication stays disabled when protected storage is unavailable.
- Each Electron window exchanges its one-time preload secret for an in-memory desktop session. Navigation and new-window creation are restricted, and no privileged endpoint trusts loopback or origin alone.
- An authenticated desktop client creates a short-lived, single-use pairing grant. Its QR code and link carry the same high-entropy secret; the host stores only a one-way verifier.
- Pairing creates a separate revocable device credential per browser. It is stored as a `Secure`, `HttpOnly`, `SameSite=Strict` cookie for the verified Pidex HTTPS origin; client JavaScript never reads it.
- WebSockets use one-time tickets valid for at most one minute so long-lived credentials never appear in WebSocket URLs.
- A paired mobile client may operate sessions in registered projects but cannot perform desktop-only administration, trust, or setting changes. Revocation blocks future requests and tickets and closes that client's active WebSockets.
- The web client uses no third-party scripts, analytics, advertising, or remote fonts and ships with a restrictive content security policy. The host enforces exact origins, schema and size limits, bounded reads, authentication rate limits, and operation timeouts.
- Security logs record bounded authentication, pairing, revocation, and remote-setup events without credentials, prompt content, or tool output.

### Persistence and recovery

- A small Pidex metadata store holds project and session references, host identity, client and pairing verifiers, prompt-action records, Pidex settings, and security events. It does not duplicate transcript bodies.
- The host is its only writer. An accepted prompt record is crash-safe before the Pi call or acceptance response.
- Startup validates project paths and Pi session references. Missing, escaped, unreadable, or malformed entries remain unavailable with recovery guidance; Pidex does not silently delete or replace them.
- Updates use forward-only metadata migrations from a pre-migration backup. Failure restores the backup, leaves Pi JSONL untouched, and prevents startup against partial state.

### Packaging and background behavior

- The macOS package includes the pinned Pi SDK, host, web client, and protocol schemas. It requires neither a separate Pi executable nor a Pidex daemon.
- Closing the last window keeps the host running while a run is active or remote access is enabled. Explicit Quit stops active runs with a bounded grace period, marks unfinished runs interrupted, flushes state, closes clients, and removes a still-owned Serve route.
- Desktop and host ship together, and mobile is served by that host. Updates wait for idle sessions and flushed state; Pi SDK upgrades must pass resume tests against existing Pidex JSONL fixtures.

### Delivery sequence

1. Build the Electron shell, loopback host, shared responsive client, typed protocol, and authenticated desktop bootstrap.
2. Connect the pinned Pi SDK for projects, trust, sessions, events, Stop, and resume without rebuilding Pi behavior.
3. Add durable action IDs, authoritative snapshots, crash recovery, and background lifecycle.
4. Complete the shared session UI, response copying, and mobile offline behavior.
5. Add pairing, per-device credentials, revocation, reconnect, and Tailscale Serve setup and cleanup.
6. Complete packaged macOS, migration, resume, security, and release testing.

## Testing Decisions

- Tests prove user-visible behavior through the highest public seam that can observe it. Shared session, authorization, and continuity behavior is tested through the host HTTP/WebSocket contract, including its public bootstrap endpoints; browser UX is tested through the production web client; Electron-only lifecycle behavior is tested through the packaged application. Tests do not assert React component state, private Pi SDK objects, implementation-specific call counts, or metadata layout.
- Because the repository has no implementation prior art yet, the first delivery phase establishes one reusable host contract harness. It starts a real isolated host, connects clients over real HTTP/WebSocket transports, and provides only public controls for time, network loss, runtime outcomes, and host restart.
- Protocol tests use that host with a deterministic adapter at the documented Pi runtime boundary. The adapter produces valid public events for prompt acceptance, streaming text, tools, stop, model and thinking changes, and compaction, plus controlled malformed events, delayed outcomes, and runtime failures; it is a test double for Pi, not a second product runtime or a mock of host internals.
- A small compatibility suite runs against the pinned Pi SDK with isolated Pidex application data. Non-inference scenarios run without external credentials where the SDK permits; inference-dependent coverage is an explicit opt-in real-provider smoke. Together they prove session creation, durable resume, prompt and event mapping, built-in tool mapping, stop, model and thinking changes, compaction, and recovery from Pi JSONL without depending on private SDK state.
- Contract tests cover version and schema rejection, message and resource size limits, desktop and mobile authorization boundaries, expected revisions, bounded transcript and tool-output paging, ordered events, event gaps, replacement snapshots, host identity changes, and concurrent clients. A forbidden mobile administration, trust, or setting change must be rejected by the host, not merely hidden in the UI.
- Prompt-delivery tests disconnect or lose the response before submission, before and after durable acceptance, during streaming, during Stop, and after completion. Retrying the same client action ID must return the recorded outcome and produce at most one accepted Pi prompt; an unresolved action blocks resubmission until an authoritative snapshot resolves it.
- Continuity tests connect desktop and mobile clients to one host, disconnect either client at each run phase, allow Pi to continue, and reconnect after missed events. Both clients must converge on the same bounded transcript, run status, effective model and thinking state, and revision; locally stored drafts remain drafts and are never submitted automatically.
- Crash tests terminate the host before and after durable action acceptance and while Pi is active, then restart through the production recovery path. Tests prove that accepted actions are not blindly repeated, interrupted work is not reported as completed, Pi JSONL and Pidex metadata remain recoverable, and the session does not accept new work until ambiguous state is resolved.
- Persistence tests terminate the host at externally meaningful project, session, pairing, accepted-action, settings, and migration boundaries. Restart exposes only complete durable outcomes, preserves unavailable projects and malformed or missing-session records with recovery guidance, never silently deletes them, and leaves the pre-migration backup recoverable when migration does not complete.
- Authentication tests cover remote access disabled by default, local desktop bootstrap origin restrictions, short-lived pairing grants that work once through the QR code or link, independently issued and revoked device credentials, one-time WebSocket ticket replay, origin mismatch, rate-limited authentication attempts, and active-connection revocation. Canary secrets placed in test credentials must never appear in HTTP/WebSocket payloads, browser-visible errors, or normal and security logs.
- Tailscale adapter tests use recorded CLI status and Serve outputs for a missing CLI, signed-out state, malformed output, missing MagicDNS, timeouts, permission failures, conflicting configuration, successful ownership, failed endpoint verification, wrong host identity, and cleanup whose ownership cannot be proven. Observable results must preserve unrelated Serve routes, keep the host loopback-only, disable application access when cleanup is unsafe, and provide actionable remediation.
- An opt-in real-Tailscale smoke runs only on a prepared Tailnet. It records the initial Serve state, enables the Pidex-owned route, verifies the expected host descriptor at the final MagicDNS HTTPS origin, pairs a fresh browser profile, exercises authenticated HTTP and WebSocket access, revokes that client, disables remote access, and proves that only the Pidex-owned route changed.
- Browser end-to-end tests use Playwright or an equivalent tool with the production web build against a real isolated host. V1 targets desktop Chromium and mobile Chrome first. Shared core scenarios cover streaming transcript and tool activity, pending and failure states, prompt and Stop gating, reconnect, and authoritative replacement after an event gap. Copying a completed assistant response must place its full host-authored text on the clipboard after multi-chunk streaming; clipboard denial must remain visible and must not report success.
- Desktop integration tests launch packaged Electron with isolated user data and verify the local bootstrap, native project-picker and trust boundaries, desktop-only model and thinking changes, paired-client review and revocation, background behavior after the last window closes, explicit Quit, relaunch recovery, and host cleanup.
- Pairing UI tests prove that the QR code and copyable link use the verified HTTPS origin, the link copy action returns that exact URL, and both paths pair a fresh browser or show an actionable error without leaking the grant. Mobile tests also cover touch layout, page suspension and network-loss recovery, local draft retention, an offline state that distinguishes host unavailability from data loss, session creation only in an existing trusted project, and protocol rejection of project registration, trust, setting changes, remote-access configuration, and paired-client administration.
- V1 large-content tests stay functional rather than enforcing quantitative performance budgets. They prove that long transcripts and oversized tool results remain usable through bounded paging, collapsed results, and on-demand loading without eagerly transferring or rendering all available content.
- Every fallible user action has success, visible pending, and visible failure coverage through the relevant client surface. Missing credentials, unavailable projects, Pi startup and resume failures, Tailscale failures, authentication failures, and reconnect failures are not accepted when observable only in logs.
- Release acceptance observes the signed or release-equivalent packaged macOS application externally, never through a development server. The hermetic gate covers Pi SDK startup and restart, desktop and mobile-responsive behavior, pairing and revocation, and recovery; environment-gated jobs add one real-provider run and prepared-Tailnet access. Across both paths, tests prove Pidex exposes only Pi and creates no public or LAN listener, cloud service, relay, SSH process, or non-Tailscale remote endpoint.

## Out of Scope

- Any coding agent other than Pi, including Codex, Claude Code, and OpenCode.
- ACP, a generic coding-agent provider interface, third-party agent adapters, or an agent plugin marketplace.
- A native mobile application.
- A separately hosted mobile web application.
- Mobile Safari and browsers other than the supported mobile Chrome target in v1.
- Pidex user accounts, cloud sync, telemetry, fleet management, or a hosted control plane.
- A public or self-hosted Pidex relay.
- Any remote-access or pairing path other than Pidex-managed Tailscale Serve HTTPS, including LAN access or pairing, raw Tailnet-IP HTTP, custom endpoints, reverse proxies, Tailscale Funnel, Tailscale SSH, ordinary SSH launch, port forwarding, or Wake-on-LAN.
- Mobile access without an awake desktop running Pidex and connected to Tailscale.
- Registering or removing projects, entering or browsing host paths, changing project trust, changing remote-access configuration, or managing paired clients from mobile.
- Pairing by manually entering a code or password.
- Read-only pairing, per-project access scopes, multi-user roles, approval workflows, team accounts, or session sharing between different users.
- Remembering or switching among more than one Pidex host in a mobile browser profile.
- Offline mobile execution, offline mutation queues, or automatic prompt submission after reconnect.
- Pidex controls for renaming or archiving sessions, or mobile controls for changing a session's model or thinking level.
- Session import from any source, or attaching to or modifying sessions created by standalone Pi or another application.
- Pi conversation-tree browsing, Continue from here, native Fork or Clone, label editing, or exporting a complete session transcript.
- Third-party Pi extensions, extension-provided interactive UI or commands, themes, keybindings, prompt-template UI, custom TUI widgets, or full terminal UI parity.
- Quantitative performance budgets or benchmark gates beyond functional bounded-loading behavior in v1.
- Steering and follow-up queues while Pi is running.
- Separate Pidex UI or orchestration for an embedded terminal, file explorer, git status or diff review, checkpointing, worktree management, browser automation, voice input, schedules, loops, or subagents.
- A Pidex-provided MCP server, MCP client, or MCP integration layer.
- Pidex-managed model-provider login, model-provider credential storage, billing, quotas, or provider-account management.
- Per-tool permission prompts or an application sandbox.
- Windows and Linux release artifacts in v1.
- Permanent deletion of a session or its Pi JSONL file from the application in v1.

## Further Notes

### Background and retained lessons

- The earlier Pizen PRD described a broad Paseo fork with compatibility, relay, orchestration, and Pi conversation-tree requirements. Pidex starts fresh and carries over none of those product, protocol, migration, or release obligations.
- Prior work, including T3 Code, leaves useful design lessons: keep one host as the execution boundary, verify the final remote endpoint, use pairing only to create a durable client credential, restore state from authoritative snapshots, and treat live WebSocket delivery as recoverable. Pidex does not depend on T3 Code's code, APIs, protocols, data, or compatibility.
- Pidex excludes the provider registries, environment catalogs, relays, SSH launch paths, LAN listeners, native mobile clients, cloud services, git orchestration, and other broad features present in earlier products.
- The pinned Pi SDK is the only Pi integration boundary in v1. Pidex does not ship an RPC subprocess fallback or a generic runtime boundary.
- The proof of concept and v1 intentionally support a limited Pi profile. Full compatibility with Pi extensions, extension-provided providers, prompt templates, themes, keybindings, and other customization is future Pi-only work.

### Success measures

- With working Pi credentials and a local project, a developer can start from a clean Pidex profile, register and trust the project, create a session, and complete a Pi run without selecting an agent provider or entering a provider secret in Pidex.
- On a desktop already signed in to Tailscale with MagicDNS and Serve permission, and a phone on the same Tailnet, the user can go from opening Pidex's remote-access settings to viewing the session list on the paired phone in under five minutes. Tailscale installation, sign-in, and Tailnet administration are outside this measurement.
- After network reachability is restored, a disconnected mobile client receives an authoritative transcript, run status, and session revision within five seconds in the prepared-Tailnet test environment. Reconnect never submits a draft or repeats a prompt automatically.
- Every case in the continuity and response-loss test matrix records exactly one accepted Pi prompt for one client action ID, including loss before and after the host reports acceptance.
- After the host records a client revocation, that credential's next authenticated request is rejected and its active WebSocket closes within ten seconds; other clients remain connected.
- Every crash and restart case preserves committed session history, never reruns an ambiguous action, and never reports an interrupted run as completed without durable evidence.
- An external observer of the packaged release detects only a loopback Pidex listener and the explicitly enabled Tailscale Serve HTTPS route. It detects no Pidex cloud, relay, SSH, public, LAN, or raw Tailnet-IP access path.

### Acceptance criteria

- The shipped production application exposes one coding-agent runtime, Pi, and no provider selector, generic provider registry, or non-Pi runtime.
- A desktop user can register and trust a project, create and reopen a persistent session, send a prompt, observe streaming text and tool activity, stop the run, change supported model and thinking settings, restart Pidex, and resume the same session.
- From either client, one action copies the full text of a completed assistant response without requiring manual text selection.
- Pidex resolves Pi models, credentials, settings, context files, skills, and supported resources through the pinned Pi SDK. Missing credentials and ignored or unsupported resources produce actionable diagnostics, while secret values appear in neither client payloads nor normal logs.
- Standalone Pi session files remain byte-identical, and every Pidex-managed Pi session remains under Pidex-owned application data. Missing or malformed Pidex sessions remain visible as unavailable records rather than being deleted.
- Restart and update recovery preserve Pi JSONL history and Pidex metadata. Metadata publication is atomic, and each forward-only metadata migration creates a pre-migration backup.
- Desktop and mobile use the same versioned host protocol. After each accepted command or reconnect, both clients converge on the same host-authored transcript, run state, model and thinking state, and session revision.
- Losing either client connection does not stop Pi. Reconnecting after missed events yields a proven gap-free replay or a replacement snapshot before the prompt input can submit another prompt.
- The host durably records prompt acceptance before invoking Pi. Replaying a client action ID returns its recorded outcome and never accepts a second prompt; after response loss, the client resolves the action from the host before offering resend.
- Large tool results are collapsed and fetched in bounded chunks. Binary or unsupported content is represented by bounded metadata and is never inserted as an unbounded WebSocket payload.
- Mobile cannot register a host path, approve project trust, configure remote access, manage paired clients, change model or thinking settings, or expose secret material.
- Remote access remains unavailable until the desktop user explicitly enables it and Pidex verifies the final Tailscale Serve HTTPS URL, expected host identity, and protocol version. Missing Tailscale, signed-out state, missing MagicDNS or Serve permission, route conflicts, and endpoint verification failures each produce a clear setup error. The host remains bound to loopback and exposes no fallback remote path.
- The desktop shows a short-lived, single-use QR code or copyable pairing link. The pairing grant stays in the verified MagicDNS URL fragment and rejects reuse. Successful pairing mints a unique revocable device credential, and long-lived credentials never appear in HTTP logs or WebSocket URLs.
- Mobile Chrome can load the host-served app, list registered projects and sessions, create a Pidex-managed session only in an approved project, send prompts, follow streaming assistant text and tool activity, stop a run, disconnect, and reconnect.
- Desktop lists each paired client and its last connection time. Revocation rejects that client's future requests and closes its active WebSocket without affecting other clients or local desktop use.
- Disabling remote access rejects new remote authentication, closes remote WebSockets, and removes only a Tailscale Serve mapping that Pidex can prove it created. An unowned mapping remains untouched and produces manual cleanup guidance.
- Closing the last desktop window while a run is active or remote access is enabled keeps the host available in the background. Explicit Quit shuts down Pi runtimes and remote access.
- When the desktop is asleep, quit, signed out of Tailscale, or otherwise unreachable, mobile shows a clear offline state without implying that session data was lost.
- The packaged macOS application passes the real-Pi, responsive-client, authentication and revocation, restart and recovery, and prepared-Tailnet smoke tests through production startup paths.
