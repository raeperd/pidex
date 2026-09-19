# Standalone review procedures

These bundled procedures supply the phases named by the parent workflow. Require authenticated GitHub CLI access and subagent support; report actual tooling/access blockers.

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

## Stacked PRs

Read before creating dependent PR layers or modifying an existing stack. Independent work belongs on separate branches or stacks.

1. Prepare the CLI.
   - Require authenticated `gh`; install the extension with `gh extension install github/gh-stack` if missing. Use `gh stack <command> --help` for installed command flags and report unavailable tooling before dependent operations.
   - Inspect `git remote -v` and select the intended remote. Pass `--remote <name>` to remote operations; with multiple remotes, configure `remote.pushDefault` for commands without that flag.
   - Use non-interactive commands: `gh stack view --json`, `gh stack submit --auto`, and explicit branch names for `init`, `add`, and `checkout`.
   - Completion: authenticated tooling and the intended remote are available.

2. Establish layer ownership.
   - Inspect existing stacks with `gh stack view --json`. Create or adopt branches in dependency order with `gh stack init <first> [<next>...] --base <trunk>`; use `gh stack add <branch>` for a new layer above the current one.
   - Create the stack before implementing multiple layers. Each PR targets its immediate parent, and its diff/review scope includes only its own changes.
   - Before editing, identify the owning layer from stack state and file history, then run `gh stack checkout <branch>`. Preserve unrelated work.
   - Completion: the current branch owns the intended change and has the correct parent.

3. Propagate and verify changes.
   - Commit on the owning layer, then run `gh stack rebase --upstack --remote <name>` to update dependents. Use `--no-trunk` when intentionally updating only inter-branch dependencies. Resolve conflicts, stage resolutions, and run `gh stack rebase --continue`; use `--abort` to restore the stack if necessary.
   - Publish with `gh stack submit --auto --remote <name>`; new PRs are drafts. Apply the repository commit/title convention to generated titles with `gh pr edit`. Use `gh stack sync --remote <name>` to reconcile remote changes; verify the resulting state even when the command exits successfully.
   - After prerequisite changes, rerun affected layers' checks. Return changed ready PRs to draft and resume their review-pr checks before restoring readiness. Preserve review records so rebases cannot duplicate a Codex trigger within the run.
   - Verify remote bases and diffs with `gh pr view` and `gh stack view --json`. Merge only on explicit request; `gh stack merge <target> --yes --squash` includes unmerged ancestors, so verify that full scope is authorized.
   - Completion: remote bases/diffs are correct and affected PRs are verified or explicitly awaiting review/CI.
