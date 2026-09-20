# 03 — Edit drafts while a run is busy

## Description

Prepare a draft while Pi works and send it deliberately after completion.

- Electron main, Svelte renderer, and one owned backend child run the app. The backend embeds Pi and uses Effect; browser-safe Effect RPC/Schema carries authenticated loopback HTTP/WebSocket traffic.
- Backend owns the run. Send already atomically accepts nonempty input only while idle, rejects busy submissions, and stays disabled during runs. Reuse this behavior; renderer owns the unsent draft.
- Preserve editable drafts through completion. No queue, steering, or automatic submission.

Blocked by: [#130 — Stream replies and tool activity](https://github.com/raeperd/pidex/issues/130), for real Send, streaming, and idle-only acceptance.

Reference: [v0.0.1 technical spec](https://github.com/raeperd/pidex/blob/docs/v0.0.1-tech-spec/docs/v0.0.1-tech-spec.md)

## Acceptance criteria

- [ ] Given a composer-started run held busy at a controlled provider response boundary, when the user types "next task" while output arrives and tries keyboard submission, then the draft remains editable, Send is disabled, and provider invocation count stays at one.
- [ ] Given the held run and draft, when the response completes, then Idle appears, "next task" remains unchanged, and Send becomes enabled without another provider invocation. When explicitly sent, then a second invocation receives "next task".
- [ ] Given the held run, when an authenticated API client submits another prompt, then busy rejection leaves provider invocation count unchanged. Name this supporting check #131.
