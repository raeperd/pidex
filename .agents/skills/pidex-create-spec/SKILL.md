---
name: pidex-create-spec
description: Turn agreed requirements into a concise technical spec with use cases and acceptance scenarios.
url: https://github.com/mattpocock/skills/blob/main/skills/engineering/to-spec/SKILL.md
disable-model-invocation: true
---

Write one implementation target from the current conversation. Keep product decisions and shared testing rules together in the spec.

## Process

1. Establish the target.
   - Extract the goal, release scope, accepted decisions, exclusions, and requested output from the conversation. Preserve later corrections.
   - For release-scoped work, record the intended GitHub milestone/version in the target (for example, `v0.0.1`). Treat the milestone as the release grouping and keep future issue titles outcome-focused without a version prefix.
   - Read relevant existing documents and repository instructions. Reuse the canonical spec when updating; avoid creating a parallel PRD.
   - Ask only about decisions that block a useful draft. Offer short A/B/C choices when alternatives help.
   - Completion: the output path, scope, and unresolved decisions are explicit.

2. Verify decision-changing facts.
   - Inspect current code and configuration before describing existing behavior. Derive the stack and tools from this project.
   - Research uncertain SDK, persistence, lifecycle, or testing capabilities using installed documentation or primary sources. Distinguish verified behavior from proposed behavior.
   - Record a fallback only for a relevant capability gap; avoid speculative alternatives and implementation inventories.
   - Completion: each material technical claim has evidence or is clearly a proposal.

3. Write the spec.
   - Use the structure below for new documents; preserve an explicitly requested structure when editing.
   - Use concise bullets and comparison tables. Write each paragraph or list-item paragraph on one source line and let the editor wrap it.
   - Name module responsibilities, actual process boundaries, data ownership, and API behavior, including important failure/recovery semantics. Prefer the term API.
   - Pair each use case with one acceptance scenario; edge-case variants stay under that case. Use plain outcome descriptions without mandatory user-story boilerplate.
   - Link real issue numbers when issues exist. Otherwise use temporary local IDs without creating tracker issues merely to obtain numbers.
   - Completion: every in-scope outcome has acceptance coverage and clear ownership.

4. Specify shared testing and delivery rules.
   - State the public boundary under test. Prefer application/UI integration tests for user workflows; label supporting API checks as supplementary.
   - Define real components, controlled external boundaries, isolated fixtures, reproduction/debugging deliverables, and failure artifacts. Read project commands instead of inventing working commands.
   - Keep shared TDD and CI rules here: one scenario, behavioral failure, minimal implementation, then refactor green. Retain already-passing behavior as regression coverage.
   - Make release readiness depend on acceptance coverage and required checks, not a fixed PR count.
   - Completion: readers know what will prove the release works and how failures will be reproduced.

5. Save and check.
   - Default to local Markdown in the repository's documentation location. A request to discuss or draft does not authorize tracker publication.
   - Do not create GitHub milestones while drafting locally. Carry the named milestone into issue publication when the user explicitly requests tracker creation.
   - When the user requests a PR or update, include only the intended document changes and follow the repository's workflow; otherwise leave the draft local.
   - Check scope, one-to-one mappings, links, formatting, and current-versus-target claims. Report the document path and any unresolved decisions.
   - Completion: the requested artifact exists and its links and acceptance mapping are valid.

## New-document structure

- Title and target status/version.
- Problem and intended outcome: one short paragraph each.
- Use cases and acceptance scenarios: a table with issue/local ID, outcome, and scenario.
- Implementation decisions: ownership and API decisions needed to begin implementation.
- Testing decisions: coverage, controlled boundaries, debugging, and release checks.
- Implementation workflow: the shared TDD loop and issue/PR traceability.
- Out of scope: explicit exclusions.
- References or open decisions: include only when needed, with the reason to consult each reference.

Keep file layouts, large code snippets, repeated rationale, and superseded decisions out of the spec unless a concrete decision requires them.
