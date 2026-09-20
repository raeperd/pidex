# Resume a saved session after relaunch

## Description

Explicitly select saved history after Quit and continue the exact Pi JSONL session. Assume the completed [v0.0.1 baseline](../../../docs/v0.0.1-tech-spec.md) as a prerequisite. Follow the [v0.0.2 spec](../../../docs/v0.0.2-tech-spec.md).

- Server validates project/session identities, preflights the file, replaces the active Pi session, and rebinds events. Reject busy, stopping, or stale requests; publish the selected snapshot before enabling Send and ignore old-session events. Desktop updates its recovery locator only after success.
- Use supported installed Pi SDK APIs, Effect application logic, and typed API failures. Retain authenticated transport, stock Pi, context files, resource restrictions, and selected-session lifecycle behavior. Pi owns history.
- Cover postlaunch resume through native folder selection. Recent-project navigation, cross-project switching, and composer draft persistence remain separate issues.

Blocked by: [List saved sessions](01-list-project-sessions.md), which supplies the list and validated project/session identities.

## Acceptance criteria

- [ ] Given real Electron/Pi, temporary session files, and a controlled provider, when a saved session is selected after Quit, relaunch, and folder selection, then its transcript appears with zero automatic provider requests.
- [ ] Given that resumed session, when a follow-up is sent, then captured provider input includes earlier context and Pi appends to the same JSONL file with earlier history intact.
- [ ] Given a listed file removed or made unreadable before selection, when Resume session is requested, then an actionable error appears, surviving files remain unchanged, and no replacement history is created. Failure preserves the previous usable selection or offers Retry with Send disabled; Send never targets an unintended session.
