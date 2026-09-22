# Publishing issues

Use this branch only for tracker creation or updates requested by the user. Preparing local drafts is part of that work, not an additional approval gate.

1. Resolve the tracker target and existing work.
   - Confirm the repository or project from the request and configured context. Search open and closed issues for the same work, including issues created earlier in the conversation.
   - Match scope as well as title. Reuse a matching issue; resolve ambiguous matches before overwriting anything. Leave unrelated and parent issues alone.
   - Completion: each draft maps to an existing issue or a deliberate new issue.

2. Publish in dependency order.
   - Use the approved local text. Pass Markdown through structured arguments or a body file, preserving real newlines.
   - Resolve the intended release milestone from the approved scope. Use `gh api` to read its canonical description and reuse the matching open milestone. When explicit issue publication is authorized and it does not exist, follow [milestone publication](../../pidex-create-milestone/references/publishing.md) to create it with the agreed plan before publishing issues. Assign every in-scope issue to that milestone; do not reopen a closed milestone without authorization.
   - Keep issue titles outcome-focused. Use the milestone for version grouping instead of adding a version prefix such as `v0.0.1: ` to titles.
   - Apply requested or configured labels and assignment conventions; derive targets from the current project rather than personal defaults from another repository.
   - Record each returned ID/URL immediately. If interrupted, retain this mapping and re-query before retrying creation.
   - Completion: every successful write has a recorded tracker identity, and retries can avoid duplicates.

3. Resolve links and relationships.
   - Replace local blocker links with actual tracker URLs. Use native blocking relationships where supported; a parent/child relationship does not substitute for a dependency.
   - Resolve remaining forward references after IDs exist. Sync local draft links and retain the local-to-tracker mapping.
   - When publishing issues from the milestone plan, replace its temporary IDs with real issue links, including testing and workflow references, through the milestone publication workflow. Preserve unrelated description content; do not create a duplicate repository spec or documentation PR for this synchronization.
   - Completion: all issue references point to the intended work, with no invented IDs or unresolved local blocker paths.

4. Read back and report.
   - Verify saved titles, bodies, and blocking relationships against the drafts; run applicable document checks for local edits.
   - Report created versus reused issues, their links, and any failed relationship or document updates. Do not claim publication or PR updates before verifying them.
   - Completion: the user can open the published work and see the intended content and dependencies.
