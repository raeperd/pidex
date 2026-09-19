# Issue handoff

Use at the end of an implementation run, including when work is blocked.

1. Refresh the evidence.
   - Read relevant issue dependencies, PR merge states, and likely code ownership before recommending follow-up work.
   - Identify the issue's final implementation PR. If implementation is incomplete, use the latest relevant PR and describe progress rather than completion.
   - Completion: the target PR, remaining work, and actual dependency state are known.

2. Post or update one concise comment.
   - Reuse the existing agent-authored handoff instead of adding duplicates.
   - State the remaining merge/closure conditions. Recommend the next linked issue with its prerequisite and reason.
   - Name issues that can proceed in parallel now or after a named prerequisite. Distinguish dependency eligibility from likely shared-file or API conflicts; suggest ownership boundaries.
   - Link actual issues/PRs. Say when no independent work is available or the next issue is unknown. For incomplete implementation, explain remaining work and blockers.
   - Completion: the saved comment accurately describes completion or progress, next work, and practical parallelism.

3. Read back the saved comment.
   - Verify its text and links, then return its URL for the implementation report.
   - Completion: the user can open the verified handoff or progress comment.
