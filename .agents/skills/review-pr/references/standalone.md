# Standalone review procedures

Use these procedures for any missing `gh-pr-ready-codex`, `gh-pr-draft`, `gh-pr-ci`, `gh-pr-review-codex`, or `code-review` skill. They supply the same phases named by the parent workflow. Require an authenticated GitHub CLI and subagent support; report actual tooling/access blockers rather than a missing personal skill.

## Draft and CI

- Reuse the target open PR; capture its URL, base/head SHAs, draft state, linked issue/spec, and existing reviews. The parent workflow converts an initially ready PR to draft before this phase.
- Check every reported check for that head with `gh pr checks <number> --json bucket,name,state,link`. Wait while pending; only `pass` or `skipping` is green. If no checks are reported, verify whether CI is expected and report missing required CI as a blocker.
- Inspect failures with `gh run list --commit <sha>` and `gh run view <run-id> --log-failed`, or the external check's link. Fix PR-caused failures, run relevant local checks, commit/push intended fixes, and repeat for the new head. Report unrelated or uncertain failures as blockers.
- Require the current head still to equal the checked head before recording green. Record each new checked head as a CI iteration.

## One Codex review cycle

1. After green CI, record `reviewed_sha`. Inspect the local run record and PR activity before posting so resuming cannot duplicate a trigger.
   ```sh
   gh api --method POST repos/<owner>/<repo>/issues/<number>/comments -f body='@codex review'
   ```
   Record the returned comment ID, creation time, URL, and reviewed SHA immediately. Send exactly one trigger per PR in this workflow, even after fixes or rebases.
2. Poll the trigger's reactions and PR reviews:
   ```sh
   gh api repos/<owner>/<repo>/issues/comments/<trigger-id>/reactions
   gh api --paginate repos/<owner>/<repo>/pulls/<number>/reviews
   ```
   Accept a `+1` reaction from `chatgpt-codex-connector*` as no findings, or a review from that bot matching `reviewed_sha` and submitted after the trigger. `eyes` is acknowledgment only. Include findings in the review body as well as its inline comments.
3. Fetch findings with `gh api repos/<owner>/<repo>/pulls/<number>/reviews/<review-id>/comments`. Classify all findings; fix accepted ones, reject with evidence, and retain escalations. Verify fixes and final-head CI before concluding.
4. Reply to each concluded finding using `POST repos/<owner>/<repo>/pulls/<number>/comments/<comment-id>/replies`. Use structured JSON or a body file; include the decision and supporting evidence or fix commit and verification.
5. Query GraphQL `repository.pullRequest.reviewThreads` with pagination, including `id`, `isResolved`, and comment `databaseId`. Match each REST comment to its thread. Resolve concluded threads with the mutation below and require `isResolved: true`; escalations remain unresolved.
   ```graphql
   mutation($threadId: ID!) {
     resolveReviewThread(input: {threadId: $threadId}) {
       thread { id isResolved }
     }
   }
   ```

## Independent code review

The review coordinator launches separate Standards and Spec subagents. Give each the immutable diff `git diff <base>...<head>`, commit list `git log <base>..<head> --oneline`, and layer scope. Confirm revisions exist and the diff is nonempty. Resolve the spec from the linked issue and its accepted spec; ask only if the intended requirements cannot be established.

- **Standards:** provide repository instructions and relevant conventions. Require file/line evidence for violations, skipping tooling-enforced rules. Consider naming, duplication, misplaced responsibility, data clumps, primitive obsession, repeated dispatch, scattered changes, mixed responsibilities, speculative abstractions, long navigation chains, pointless delegation, and unused inheritance only as judgment calls; repository rules take precedence.
- **Spec:** provide the issue/spec and accepted decisions. Report missing or partial requirements, unintended scope, and incorrect behavior with requirement quotes and file/line evidence. Judge only the selected layer's promised behavior.
- Keep reports separate under Standards and Spec, with counts for each. Findings need an actionable consequence; do not turn preferences into blockers. The parent agent classifies and fixes findings and requests follow-up review only for changed portions.

## Final readiness

Return to the parent workflow's readiness gate. It requires both reviews resolved, no escalation, resolved concluded threads, and final-head CI green. Then run `gh pr ready <number>` and verify `headRefOid`, `baseRefOid`, and `isDraft` with `gh pr view`. Report reviewed/final SHAs, decisions, CI iterations, and readiness. Do not merge.
