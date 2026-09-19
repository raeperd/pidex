---
name: implement-issue
description: Implement a GitHub issue with behavior-focused TDD and small draft PRs, stacking dependent changes when needed.
disable-model-invocation: true
---

Run with `$implement-issue <issue URL>`. This workflow includes implementation, verification, commits, pushes, and draft PR creation unless the user narrows the request. Review and readiness are a separate invocation: `$review-pr <PR URL>`.

## Process

1. Resolve scope and supporting skills.
   - Read the issue, linked spec, comments, blockers, and repository instructions. Apply later user corrections and distinguish implemented behavior from the target.
   - Locate and read `implement` and `tdd` through the skill catalog or repository/personal skill directories. Follow their implementation and validation guidance; reserve `implement`'s final independent review for `review-pr`.
   - Use the issue and spec's approved test boundaries without requesting approval again. Use one scenario → red → minimal green → refactor, preserving already-passing behavior as regression coverage. These repository decisions take precedence over conflicting supporting-skill rules.
   - Discover applicable implementation skills from the actual files and stack. Report missing supporting skills or prerequisites; ask only for product decisions that block work.
   - Completion: scope, acceptance criteria, approved test boundaries, and prerequisites are known; required skills are available.

2. Establish branches and PR boundaries.
   - Inspect working-tree changes and existing implementation PRs before creating a separate branch/worktree. Preserve unrelated work and reuse existing issue work.
   - Verify prerequisite implementations. Base dependent work on their implementation branches or merged commits; report a blocker when required implementation is absent.
   - Plan one cohesive outcome per PR using the size guidance below. Record each layer's starting commit and intended base for later review.
   - For dependent PRs, locate and read `gh-stack` and its stack-design reference. Create the stack before implementing multiple layers and follow its non-interactive commands and remote selection rules. Report unavailable stack support before dependent operations.
   - Use separate branches or stacks for independent work.
   - Completion: the active branch owns the next change, and each planned PR has a base, scope, and review fixed point.

3. Implement one acceptance scenario at a time.
   - Prefer application/UI integration tests of observable user behavior. Add unit tests only when meaningful edge cases are covered more effectively; they supplement acceptance coverage.
   - Run real application components and control only the external boundaries allowed by the spec. Use isolated fixtures, explicit synchronization, and reliable cleanup.
   - Observe the expected behavioral failure, make the smallest change that passes, then refactor with tests green. Keep code simple, concise, and readable with clear module ownership. Add shared setup and dependencies only when needed.
   - Run targeted checks as behavior changes. Keep implementation and its tests in the same PR.
   - Completion: the layer's behavior is covered and passing, with no unfinished behavior presented as complete.

4. Verify and publish each layer as a draft.
   - Run relevant repository checks and acceptance scenarios visibly when supported. Record exact rerun/step-through commands, fixture setup, and failure artifact locations.
   - Inspect the final diff and commit only intended changes after validation. Create or update a draft PR; use `gh-stack` for dependent layers. Each PR targets its immediate parent so its diff contains only its own changes.
   - Describe the outcome, dependency PRs, remaining issue scope, review fixed point, and actual verification. Reference the issue throughout; reserve a closing reference for the PR completing all criteria.
   - Verify remote bases, diffs, draft state, and CI. Fix PR-caused failures and report unrelated or uncertain blockers accurately.
   - Completion: the layer has a draft PR with verified scope and passing checks, or a specific blocker is recorded.

5. Continue and hand off.
   - Repeat until all acceptance criteria are implemented. Rebase and revalidate dependent layers after prerequisite changes, following `gh-stack`.
   - Report completed criteria, remaining work, PR links in dependency order, verification results, and blockers. Provide `$review-pr <PR URL>` for each completed draft; run it only when the user also requests the review phase.
   - Keep the issue open until all acceptance criteria pass and its implementation PRs merge. This skill finishes with draft PRs; merging requires an explicit request.
   - Completion: implementation is delivered in verified draft PRs, or remaining work is explicitly blocked.

## PR size

- Aim for 100–300 handwritten changed lines, counting additions and deletions, including tests.
- Above 500 lines, look for a cohesive split. Assess generated files, lockfiles, and mechanical deletions separately.
- Prefer one understandable, independently working change over an arbitrary line limit. Keep behavior and its tests together; one issue may require several PRs.
- Measure stacked PRs against their immediate parent, not the trunk. Plan splits before accumulating a large diff.
