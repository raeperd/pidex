# 09 — Confirm Quit and clean up running work

## Description

Avoid accidental interruption and finish cancellation before confirmed Quit exits.

- Electron main owns Quit, native confirmation, and one backend child embedding Pi. The backend owns the run; confirmed Quit waits for Pi cancellation acknowledgment, disposes the session/backend, then exits Electron. Idle Quit already works.
- Use Effect backend logic and the authenticated loopback Effect RPC/Schema API for cancellation.
- Cancellation preserves Pi-owned JSONL history and tool file edits, without rollback. Unfinished output may be unsaved; an interrupted first turn may lack a session file.

Blocked by: [#132 — Stop a run and continue the conversation](https://github.com/raeperd/pidex/issues/132), for acknowledged Pi cancellation.

Reference: [v0.0.1 technical spec](https://github.com/raeperd/pidex/blob/docs/v0.0.1-tech-spec/docs/v0.0.1-tech-spec.md)

## Acceptance criteria

- [ ] Given saved history and an active run held at a controlled provider response, when Quit opens native confirmation and the user chooses Cancel, then Electron and backend remain alive and the same run displays the next released text, "Still working".
- [ ] Given that run has written note.txt with "hello", when a second Quit receives Confirm, then hold acknowledgment at the controlled provider cancellation boundary and verify both processes remain alive. When acknowledgment releases, then an external fixture observes both processes exit, confirms prior saved history remains, and reads "hello" from note.txt. Assert no UI after exit.
