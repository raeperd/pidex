# Start another session in the current project

## Description

Offer New session from the selected project's list and idle sessions. Requires the completed [v0.0.1 workflow](../../../docs/v0.0.1-tech-spec.md); recent projects and Resume session are independent. Supplemental context: [v0.0.2 spec](../../../docs/v0.0.2-tech-spec.md).

- Server owns replacement and old-listener cleanup, keeps one active Pi session, and serializes New session with Send. Validate targets; later switching composes this operation.
- Preflight before releasing the current session. Publish the replacement snapshot before enabling Send, ignore old-session events, and update Desktop's recovery locator only after success. Preserve Pi-owned JSONL history without copies.
- Use typed Effect failures. Retain authenticated transport and stock Pi tools and context files. Extensions, skills, templates, themes, custom prompts, and package resources stay disabled. Composer draft persistence is separate.

Blocked by: [List saved sessions](01-list-project-sessions.md), which supplies the selected project's list and validated project/session identities.

## Acceptance criteria

- [ ] Given real Electron/Pi, temporary projects/sessions, and a controlled provider, when New session is chosen, then the composer and transcript are empty without a provider request. Cover both an empty project list and an idle session as starting states. Sending creates a distinct saved session in the same project; provider input excludes earlier messages and earlier history stays unchanged.
- [ ] Given a running or stopping session, when New session is attempted, then the UI disables it and supplemental API checks reject it, including races with Send, without replacing the active session.
- [ ] Given replacement fails, when New session is requested, then an actionable error retains the previous usable selection or offers Retry with Send disabled; history and recovery locator remain unchanged.
- [ ] Given delayed old-session events, when New session completes, then they cannot populate the transcript or enable Send against the wrong target.
