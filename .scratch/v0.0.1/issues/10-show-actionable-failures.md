# 10 — Show actionable authentication and provider failures

## Description

Understand authentication/model/provider failures without losing drafts or remaining busy.

- One owned backend child embeds Pi. Carry SDK failures through typed Effect errors and authenticated loopback Effect RPC/Schema into Svelte UI. Credentials never reach renderer payloads or logs; sanitize diagnostics.
- Use normal Pi authentication/default-model resolution and the pinned SDK's stock retry/compaction defaults. Add no login UI, model picker, or credential hot reload.
- Failures end busy state. Drafts remain editable; Send stays disabled while credentials/model are unavailable.

Blocked by: [#130 — Stream replies and tool activity](https://github.com/raeperd/pidex/issues/130), for sending and displaying run status.

Reference: [v0.0.1 technical spec](https://github.com/raeperd/pidex/blob/docs/v0.0.1-tech-spec/docs/v0.0.1-tech-spec.md)

## Acceptance criteria

- [ ] Given temporary Pi configuration without usable credentials, when launching and selecting a project, then the UI identifies the authentication problem, explains how to correct existing Pi setup, and disables Send.
- [ ] Given temporary configuration whose default model cannot resolve, when launching and selecting a project, then the UI explains the model configuration problem and corrective action, with Send disabled.
- [ ] Given a held provider response after Send and draft "next task", when the controlled provider returns retryable failures until stock retries exhaust, then the UI shows a usable provider error and Idle, preserves the editable draft, and provider attempts stop under stock policy.
