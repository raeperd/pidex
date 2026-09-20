# Start another conversation in the current project

## Description

Offer New from the selected project's list and idle conversations. Requires the completed [v0.0.1 workflow](../../../docs/v0.0.1-tech-spec.md); recent projects, listing, and Resume are independent. Supplemental context: [v0.0.2 spec](../../../docs/v0.0.2-tech-spec.md).

- Server owns replacement and old-listener cleanup, keeps one active Pi session, and serializes New with Send. Validate targets; later switching composes this operation.
- Preflight before releasing the current session. Publish the replacement snapshot before enabling Send, ignore old-session events, and update Desktop's recovery locator only after success. Preserve Pi-owned JSONL history without copies.
- Use typed Effect failures. Retain authenticated transport and stock Pi tools/instructions. Extensions, skills, templates, themes, custom prompts, and package resources stay disabled. Draft persistence is separate.

## Acceptance criteria

- [ ] Given real Electron/Pi, temporary projects/sessions, and a controlled provider, when New is chosen from an empty project list or idle conversation, then the composer and transcript are empty without a provider request. Sending creates a distinct saved session in the same project; provider input excludes earlier turns and earlier history stays unchanged.
- [ ] Given a running or stopping conversation, when New is attempted, then the UI disables it and supplemental API checks reject it, including races with Send, without replacing the active session.
- [ ] Given replacement fails, when New runs, then an actionable error retains the previous usable selection or offers Retry with Send disabled; history and recovery locator remain unchanged.
- [ ] Given delayed old-session events, when New completes, then they cannot populate the transcript or enable Send against the wrong target.
