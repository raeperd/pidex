# 05 — Reconnect without repeating prompts

## Description

Recover output after connection loss without repeating prompts or interrupting Pi.

- Electron/Svelte connects through authenticated loopback Effect RPC/Schema to one backend child embedding Pi. Effect backend logic owns the live session and runs independently of connections; disconnecting must preserve both.
- Watch supplies an initial snapshot then ordered updates without gaps. Reconnect reconciles acceptance; never automatically resend prompts or add persisted replay storage.

Blocked by: [#130 — Stream replies and tool activity](https://github.com/raeperd/pidex/issues/130), for Send, streaming, and snapshots.

Reference: [v0.0.1 technical spec](https://github.com/raeperd/pidex/blob/docs/v0.0.1-tech-spec/docs/v0.0.1-tech-spec.md)

## Acceptance criteria

- [ ] Given a composer submission accepted by the backend and a held controlled provider response, when the actual connection drops before acknowledgment, then the same backend and Pi run continue. Release the response and verify one prompt execution with no duplicate provider work, counting expected requests and tool effects.
- [ ] Given output produced while disconnected, when reconnecting during the run, then snapshot output returns before ordered live updates without gaps and status is Running. When the run finishes, show Idle; also reconnect after completion and verify final output and Idle.
- [ ] Given a draft and a connection fault before acceptance, when disconnected, then the draft remains editable, Send is disabled, and no resend occurs. Reconnect exposes unresolved acceptance as uncertain; delivery may be lost.
