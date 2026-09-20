# 06 — Keep work running when the window closes

## Description

Close the window during work and reopen the same live conversation.

- macOS runs Electron main, a Svelte window, and one owned backend child embedding Pi. Main owns window/child lifetime and the session locator; backend Effect logic owns runs independently of renderers.
- Authenticated loopback Effect RPC/Schema supplies a snapshot followed by ordered updates without gaps. A recreated renderer subscribes to the existing project/session; Pi JSONL remains authoritative.
- Window close leaves main/backend alive and retains the session. Full Quit is separate. Renderer-only unsent drafts need not survive window destruction.

Blocked by: [#130 — Stream replies and tool activity](https://github.com/raeperd/pidex/issues/130), for backend-owned runs and snapshot initialization.

Reference: [v0.0.1 technical spec](https://github.com/raeperd/pidex/blob/docs/v0.0.1-tech-spec/docs/v0.0.1-tech-spec.md)

## Acceptance criteria

- [ ] Given a held provider response, when the actual window closes, then external fixture observations show unchanged main/backend process identities. When the provider releases "Finished", then work completes without a renderer. When app activation recreates the window, then existing history shows "Finished" and Idle, with no duplicate prompt invocation or new session.
- [ ] Given a held run and closed window, when app activation reopens it while held, then ordered output and Running return. When the provider finishes, then output continues in order and reaches Idle without another prompt invocation.
