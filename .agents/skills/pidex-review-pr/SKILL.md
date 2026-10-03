---
name: pidex-review-pr
description: Resolve independent subagent reviews and GitHub review threads, then mark verified PRs ready. Use when pidex-implement-issue reaches review or the user requests PR review and readiness.
---

Run directly with `$pidex-review-pr <PR URL>` or as the review phase of `pidex-implement-issue`. Either request includes the independent review, review fixes, commits/pushes, replies, thread resolution, and readiness unless the user narrows the scope. Merge only when explicitly requested.

## Process

1. Resolve the PR and review scope.
   - Use the bundled CI, independent review, and review thread procedures linked below. Require authenticated GitHub CLI access and subagent support; report actual tooling/access blockers.
   - Read the PR, linked issue/spec, existing reviews, and repository instructions. Resolve its working branch without disturbing unrelated changes. Stop if merged or closed. For an open ready PR, record its initial state, run `gh pr ready <number> --undo`, and verify draft state before proceeding. Restore readiness only after all gates below pass.
   - Check the PR title and new commit messages against the [repository commit/title convention](../references/commit-conventions.md). Apply it to review-fix commits and the final PR title.
   - Check the PR milestone against [PR milestones](../references/pr-milestones.md); assign it when missing or wrong.
   - Pin the actual PR base and head SHAs, diff command, and commit list. For stacked PRs, review only the layer above its immediate parent; follow [stacked PRs](../references/stacked-prs.md) before changing stack branches.
   - The parent agent owns edits and GitHub mutations. Reviewers return findings without editing the branch or changing readiness.
   - Completion: the open draft, intended scope, immutable review revisions, and supporting procedures are known.

2. Run the review.
   - Follow the [CI procedure](references/ci.md). Hold final readiness until the remaining steps here pass.
   - While waiting for CI, launch a separate coordinator subagent to follow the [independent review procedure](references/code-review.md). Give it the issue/spec, layer scope, pinned base and head, diff command, and commit list.
   - That coordinator launches independent Standards and Spec subagents and returns their separate findings. Use an isolated checkout or immutable SHAs so ongoing fixes cannot change the reviewed diff.
   - Record the independent review revisions in a local run record keyed by PR. Resume interrupted work from that record and GitHub activity.
   - Completion: the independent review has returned results for recorded revisions, or a CI/review blocker leaves the PR in draft.

3. Resolve every finding and verify fixes.
   - Classify findings as accepted, rejected with evidence, or escalated. Implement accepted fixes and verify them; keep Standards and Spec findings distinct.
   - Have the independent reviewer check subsequent fixes or rebases against its reviewed revision. Repeat only when new changes or findings require it.
   - Address unresolved GitHub review threads in scope using the [review thread procedure](references/review-threads.md). Reply with the decision, evidence, or fix commit and verification; resolve concluded threads and verify their resolved state. Keep escalations unresolved.
   - Stabilize CI on the final head using the bundled CI procedure, including after fixes or rebases. Unrelated or uncertain failures leave the PR in draft with evidence.
   - Apply the shared stacked-PR procedure to any fixes affecting dependent layers.
   - Completion: all findings have decisions, no escalation remains, accepted fixes are verified, concluded threads are resolved, and every reported final-head check passes or skips.

4. Mark the verified head ready.
   - Check the final body against the repository [PR template](../../../.github/pull_request_template.md). Update it to match the delivered scope and actual verification before readiness.
   - Re-read the PR head and base. Require them to match the final verified revisions; the head must match the final green CI SHA and independent review plus follow-up coverage. Validate changed revisions before proceeding.
   - Run `gh pr ready <number>`, then verify `isDraft: false` and the expected head/base SHAs with `gh pr view --json headRefOid,baseRefOid,isDraft,url`.
   - If this run later changes an already-verified stack layer, return that PR to draft and repeat affected independent review and CI checks before restoring readiness.
   - Completion: readiness belongs to the exact verified head and base; blocked PRs remain drafts.

5. Report.
   - Include the PR URL, independent review revisions, final SHA, decisions, resolved threads, CI iterations, and readiness state. Identify any affected dependent PRs still needing verification.
   - Completion: the user can distinguish verified ready PRs from remaining draft or blocked work.
