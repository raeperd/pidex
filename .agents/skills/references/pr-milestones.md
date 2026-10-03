# PR milestones

Every PR carries exactly one milestone from creation onward, so each release milestone lists all work that shipped in it.

1. Choose the milestone, taking the first rule that applies.
   - The PR implements or fixes a milestone issue: use that issue's milestone.
   - The PR defines or plans a milestone (spec, design prototype, issue breakdown): use that milestone.
   - Otherwise (maintenance, CI, tests, dependencies, process docs): use the active milestone, the lowest open version that still has open issues. List candidates with `gh api 'repos/OWNER/REPO/milestones?state=open'`.
   - When linked issues span milestones or no rule fits, ask the user and leave the PR unassigned until they answer.
   - Completion: one milestone title is chosen, or the PR is reported as unassigned with the reason.

2. Assign and verify.
   - Pass `--milestone "<title>"` to `gh pr create`. For existing PRs, including `gh stack submit` layers, run `gh pr edit <number> --milestone "<title>"`.
   - Read it back with `gh pr view <number> --json milestone`.
   - Completion: every PR created or updated in the run reports the chosen milestone.
