# PR milestones

Assign every PR exactly one milestone when you create it, so each release milestone lists all work that shipped in it.

1. Choose the milestone, taking the first rule that applies.
   - The PR implements or fixes an issue in an open milestone: use that issue's milestone.
   - The PR defines or plans a milestone (spec, design prototype, issue breakdown): use that milestone.
   - Otherwise (maintenance, CI, tests, dependencies, process docs, follow-ups to closed milestones): use the active milestone, the lowest open version that still has open issues. List candidates with `gh api 'repos/OWNER/REPO/milestones?state=open'`.
   - When linked issues span open milestones or no rule fits, leave the PR unassigned and name it with the reason in the final report.
   - Completion: one milestone title is chosen, or the PR is recorded as unassigned with the reason.

2. Assign it with `gh pr create --milestone "<title>"`, or `gh pr edit <number> --milestone "<title>"` for an existing PR.
   - Completion: `gh pr view <number> --json milestone` shows the chosen milestone for every PR created in the run.
