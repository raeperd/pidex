---
name: pidex-create-milestone
description: Create or update a GitHub milestone plan with gh CLI, keeping scope, acceptance scenarios, and delivery rules in its description.
url: https://github.com/mattpocock/skills/blob/main/skills/engineering/to-spec/SKILL.md
disable-model-invocation: true
---

Define one milestone from the current conversation. Its GitHub description is the canonical plan for product decisions and shared testing rules. Use `gh` CLI to create or update it when requested; discussion or draft-only requests stay local. Write drafts to `.scratch/<milestone-slug>/description.md`, without maintaining a duplicate plan in repository docs. Use [pidex-create-issues](../pidex-create-issues/SKILL.md) for requested issue publication.

## Process

1. Establish the milestone target.
   - Extract the goal, release scope, accepted decisions, exclusions, and requested output from the conversation. Preserve later corrections.
   - For release-scoped work, record the intended GitHub milestone/version in the target (for example, `v0.0.1`). Treat the milestone as the release grouping and keep future issue titles outcome-focused without a version prefix.
   - Resolve the repository and milestone from the request and configured context. Read the existing and previous milestone descriptions with `gh api`, the state of their issues and open PRs, relevant documents, and repository instructions. Reuse the matching milestone when updating.
   - Ask only about decisions that block a useful draft. Offer short A/B/C choices when alternatives help.
   - Completion: the repository, milestone target, draft-versus-publication intent, scope, and unresolved decisions are explicit.

2. Verify decision-changing facts.
   - Fetch `origin` and inspect the latest `main` before describing existing behavior. Treat open issues and unmerged PRs as prerequisites, not current behavior. Derive the stack and tools from this project.
   - Scope work that relies on an unbuilt prerequisite as out of scope, or name the blocking issue.
   - Research uncertain SDK, persistence, lifecycle, or testing capabilities using installed documentation or primary sources. Distinguish verified behavior from proposed behavior.
   - Record a fallback only for a relevant capability gap; avoid speculative alternatives and implementation inventories.
   - Completion: each material technical claim matches the latest `main` or a cited source, or is clearly a proposal.

3. Write the milestone description.
   - Use the structure below for new descriptions; preserve an explicitly requested structure when editing.
   - Use concise bullets and comparison tables. Write each paragraph or list-item paragraph on one source line and let the editor wrap it.
   - Name module responsibilities, actual process boundaries, data ownership, and API behavior, including important failure/recovery semantics. Prefer the term API.
   - Pair each use case with one acceptance scenario; edge-case variants stay under that case. Use plain outcome descriptions without mandatory user-story boilerplate.
   - Size each use case as one issue, typically one or two PRs. Split a case that bundles outcomes with different costs or prerequisites, or that depends on an open decision.
   - Link real issue numbers when issues exist. Otherwise use temporary local IDs without creating tracker issues merely to obtain numbers.
   - Use absolute GitHub URLs for repository files and related milestones so links work in the milestone description. Link durable architecture, glossary guidance, and the previous milestone's rules instead of duplicating them.
   - Completion: every in-scope outcome has acceptance coverage and clear ownership.

4. Specify shared testing and delivery rules.
   - Link the previous milestone's testing and delivery rules and state only additions and changes. Define the full rules below for a first milestone or a changed rule.
   - State the public boundary under test. Prefer application/UI integration tests for user workflows; label supporting API checks as supplementary.
   - Define real components, controlled external boundaries, isolated fixtures, reproduction/debugging deliverables, and failure artifacts. Read project commands instead of inventing working commands.
   - Keep shared TDD and CI rules here: one scenario, behavioral failure, minimal implementation, then refactor green. Retain already-passing behavior as regression coverage.
   - Make release readiness depend on acceptance coverage and required checks, not a fixed PR count.
   - For multi-issue work, show implementation order and parallel groups in the implementation workflow. Prefer a compact arrow sequence such as `A → (B, C, D in parallel) → E → F`; use a dependency graph when the relationships need more detail.
   - Name the capabilities that make prerequisites necessary and any shared API or file ownership that needs coordination during parallel work. Include only real blockers; keep the order synchronized with GitHub blocking relationships when issues exist.
   - Completion: readers know what will prove the release works and how failures will be reproduced.

5. Publish and check.
   - Check scope, one-to-one mappings, issue-sized use cases, links, formatting, current-versus-target claims, and that the implementation order covers every issue without dependency cycles.
   - For requested milestone creation or updates, follow [publishing with gh CLI](references/publishing.md). Existing authorization is sufficient; do not require a separate approval or documentation PR for the description.
   - For discussion or draft-only requests, return the draft or its `.scratch/` path without changing GitHub. A PR request alone does not authorize milestone publication.
   - Read back published content, verify the intended changes, and report the milestone URL and unresolved decisions. Preserve a failed publication's draft and report the failure without claiming completion.
   - Completion: the requested description is verified on GitHub, or the requested local draft is reviewable.

## Milestone-description structure

- Start with a short plain-text summary. GitHub already displays the milestone title, version, and status; do not repeat them as an opening heading. Use `##` for the sections below and `###` for subsections.
- Problem and intended outcome: one short paragraph each.
- Use cases and acceptance scenarios: a table with issue/local ID, outcome, and scenario.
- Implementation decisions: ownership and API decisions needed to begin implementation, one bullet per owner or concern.
- Testing decisions: coverage, controlled boundaries, debugging, and release checks.
- Implementation workflow: dependency order, parallel work, the shared TDD loop, and issue/PR traceability.
- Out of scope: explicit exclusions.
- References or open decisions: include only when needed, with the reason to consult each reference.

The description states decisions. Keep verification evidence in the conversation or PR, and keep file layouts, large code snippets, rationale, rules restated from previous milestones, and superseded decisions out of the description unless a concrete decision requires them.
