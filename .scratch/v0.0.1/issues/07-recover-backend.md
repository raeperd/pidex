# 07 — Recover the saved session after a backend crash

## Description

Manually restart a crashed backend and recover the exact saved Pi conversation.

- Electron main survives crashes, retaining the exact Pi session locator and project. Restart creates one owned backend child embedding Pi; backend logic uses Effect.
- Svelte communicates through authenticated loopback Effect RPC/Schema. Recovery restores history/current state through a snapshot followed by ordered updates. Never automatically restart, resume, or replay prompts.
- Pi JSONL is authoritative; preserve saved history without eager persistence or partial-token durability. Reconnect/window reopening are unnecessary. Missing/unreadable files belong to #136.

Blocked by: [#130 — Stream replies and tool activity](https://github.com/raeperd/pidex/issues/130), for saved turns and snapshots.

Reference: [v0.0.1 technical spec](https://github.com/raeperd/pidex/blob/docs/v0.0.1-tech-spec/docs/v0.0.1-tech-spec.md)

## Acceptance criteria

- [ ] Given completed prompt "Remember pear", controlled reply "Saved pear", and recorded JSONL bytes, when the actual owned child is killed, then main survives, the UI shows an error and Restart, and Send stays disabled. Restart creates exactly one replacement child, restores history and Idle, preserves saved file identity/bytes, and makes no provider request.
- [ ] Given that saved turn, when "Continue" reaches a held provider response and the actual child is killed, then Restart restores saved history and reports interruption without continuation/replay. Observe old-child exit and one live replacement. Sending "Next" manually produces controlled reply "Ready" and exactly one new provider request.
