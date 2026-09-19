---
name: review-pr
description: Resolve Codex and independent subagent reviews and mark verified PRs ready. Use when implement-issue reaches review or the user requests PR review and readiness.
---

Run directly with `$review-pr <PR URL>` or as the review phase of `implement-issue`. Either request includes the Codex review request, review fixes, commits/pushes, replies, thread resolution, and readiness unless the user narrows the scope. Merge only when explicitly requested.

## Process

1. Resolve the PR and review scope.
   - Use the bundled CI, Codex, and independent review procedures linked below. Require authenticated GitHub CLI access and subagent support; report actual tooling/access blockers.
   - Read the PR, linked issue/spec, existing reviews, and repository instructions. Resolve its working branch without disturbing unrelated changes. Stop if merged or closed. For an open ready PR, record its initial state, run `gh pr ready <number> --undo`, and verify draft state before proceeding. Restore readiness only after all gates below pass.
   - Check the PR title and new commit messages against the [repository commit/title convention](../../../AGENTS.md). Apply it to review-fix commits and the final PR title.
   - Pin the actual PR base and head SHAs, diff command, and commit list. For stacked PRs, review only the layer above its immediate parent; follow [stacked PRs](../references/stacked-prs.md) before changing stack branches.
   - The parent agent owns edits and GitHub mutations. Reviewers return findings without editing the branch, requesting Codex, or changing readiness.
   - Completion: the open draft, intended scope, immutable review revisions, and supporting procedures are known.

2. Run both reviews.
   - Follow the [CI procedure](references/ci.md), then the single [Codex review cycle](references/codex-review.md). Hold final readiness until the remaining steps here pass.
   - While waiting for CI or Codex, launch a separate coordinator subagent to follow the [independent review procedure](references/code-review.md). Give it the issue/spec, layer scope, pinned base and head, diff command, and commit list.
   - That coordinator launches independent Standards and Spec subagents and returns their separate findings. Use an isolated checkout or immutable SHAs so ongoing fixes cannot change the reviewed diff.
   - Only the parent agent sends the `@codex review` trigger using the bundled procedure. Record the trigger, reviewed SHA, and independent review revisions in a local run record keyed by PR. Resume interrupted work from that record and GitHub activity without duplicating the trigger.
   - Completion: one Codex cycle and the independent review have returned results for recorded revisions, or a CI/review blocker leaves the PR in draft.

3. Resolve every finding and verify fixes.
   - Classify findings from both reviews as accepted, rejected with evidence, or escalated. Implement accepted fixes and verify them; keep Standards and Spec findings distinct.
   - Have the independent reviewer check subsequent fixes or rebases against its reviewed revision. Repeat only when new changes or findings require it. Later heads intentionally receive no second Codex request during this run.
   - Address any other unresolved GitHub review threads in scope. Reply with the decision, evidence, or fix commit and verification; resolve concluded threads and verify their resolved state. Keep escalations unresolved.
   - Stabilize CI on the final head using the bundled CI procedure, including after fixes or rebases. Unrelated or uncertain failures leave the PR in draft with evidence.
   - Apply the shared stacked-PR procedure to any fixes affecting dependent layers.
   - Completion: all findings have decisions, no escalation remains, accepted fixes are verified, concluded threads are resolved, and every reported final-head check passes or skips.

4. Mark the verified head ready.
   - Re-read the PR head and base. Require them to match the final verified revisions; the head must match the final green CI SHA and independent review plus follow-up coverage. Validate changed revisions before proceeding.
   - Run `gh pr ready <number>`, then verify `isDraft: false` and the expected head/base SHAs with `gh pr view --json headRefOid,baseRefOid,isDraft,url`.
   - If this run later changes an already-verified stack layer, return that PR to draft and repeat affected independent review and CI checks before restoring readiness. Retain its recorded Codex cycle rather than requesting another.
   - Completion: readiness belongs to the exact verified head and base; blocked PRs remain drafts.

5. Report.
   - Include the PR URL, Codex-reviewed SHA, independent review revisions, final SHA, decisions, resolved threads, CI iterations, and readiness state. Identify post-Codex changes and any affected dependent PRs still needing verification.
   - Completion: the user can distinguish verified ready PRs from remaining draft or blocked work.
