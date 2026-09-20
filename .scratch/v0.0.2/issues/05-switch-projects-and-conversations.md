# Switch projects and conversations safely

## Description

Coordinate switching across projects and conversations without quitting. Requires the completed [v0.0.1 baseline](../../../docs/v0.0.1-tech-spec.md). Supplemental context: [v0.0.2 spec](../../../docs/v0.0.2-tech-spec.md).

- Own cross-project routing; compose prerequisite operations. Keep one active Pi session/run in one owned server child. Server replaces the runtime with destination cwd, project instructions, and subscriptions; Desktop commits its recovery locator only after success.
- Use Effect with typed failures and retain authentication/resource restrictions. Serialize Switch, New, Resume, and Send. Server/API rejects busy, stopping, and stale-target requests. Publish the selected snapshot before enabling Send; ignore previous-session events.
- Preflight destinations before releasing current work. Failure preserves the previous usable selection or offers Retry with Send disabled; preserve existing files. Draft persistence belongs to the next issue.

Blocked by: [New](02-start-new-conversation.md) for fresh-session replacement; [Recent projects](03-reopen-recent-project.md) for project navigation; [Resume](04-resume-saved-conversation.md) for saved-session replacement.

## Acceptance criteria

- [ ] Given visible macOS Electron using real preload/transport/server/Pi, two temporary projects with distinct instructions/histories, and controlled provider responses, when users switch idle conversations/projects through New and Resume, then captured requests contain selected history/instructions and real tool filesystem results prove the selected working directory.
- [ ] Given a running or stopping task, when switching is attempted, then navigation is disabled and supplemental API checks reject competing Switch/New/Resume/Send requests without changing selection.
- [ ] Given delayed old-session responses or stale-target requests, when switching completes, then old events cannot alter the transcript and stale requests cannot send or replace it.
- [ ] Given an unavailable destination folder/session file, when UI and supplemental API checks attempt switching, then an actionable error preserves files and the recovery locator; previous work remains usable or Retry appears with Send disabled.
