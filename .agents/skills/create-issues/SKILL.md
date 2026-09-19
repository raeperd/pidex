---
name: create-issues
description: Draft self-contained implementation issues from agreed scope, and publish or reuse them when requested.
url: https://github.com/mattpocock/skills/blob/main/skills/engineering/to-tickets/SKILL.md
disable-model-invocation: true
---

Turn agreed work into small, independently understandable issues. Default to local drafts; publish only within the user's explicit tracker request.

## Process

1. Read the scope.
   - Use the conversation, accepted spec, relevant repository instructions, and current implementation. Read supplied issue references and comments before rewriting their work.
   - Distinguish a request to discuss possible issues, draft files, or publish. Respect existing authorization without repeatedly asking for approval.
   - Read tracker and label conventions when present. Ask only for missing information that could send work to the wrong target or change its meaning.
   - Completion: the intended work and output destination are known.

2. Choose vertical slices and blockers.
   - Preserve an agreed one-issue-per-use-case mapping. Each issue should deliver one demonstrable outcome through the necessary layers; keep edge variants together.
   - Include only dependencies that actually gate implementation. Number local drafts in dependency order and check for cycles.
   - Discuss a necessary split or merge before changing agreed scope. For mechanical refactors that cannot land incrementally, describe a compatible migration sequence instead of forcing feature slices.
   - Completion: every use case is covered once, and each blocker names a required capability.

3. Draft each issue using the two-section template below.
   - The title and body must contain enough context to implement the outcome without reading the tech spec. Links supplement that context.
   - Include only relevant ownership, API behavior, persistence/lifecycle constraints, and scope limits. Research a missing fact only when it could change implementation or acceptance.
   - Write observable Given/When/Then criteria with concrete starting conditions and results. Include scenario-specific controlled inputs, files, or process failures when needed; avoid private implementation assertions.
   - Keep shared TDD procedures, CI checklists, and generic artifact rules in the spec or repository guidance. Omit redundant status, goal, and source-ID fields.
   - Use short bullets and one source line per paragraph. Aim for roughly 150–250 words; preserve necessary behavior over an arbitrary limit.
   - Completion: each issue has a clear outcome, sufficient local context, and testable acceptance criteria.

4. Save and review local drafts.
   - Write one file per issue under `.scratch/<feature-slug>/issues/<NN>-<slug>.md`; reuse existing drafts when revising. Keep blockers as relative links until tracker IDs exist.
   - When the user requests parallel agents, assign one file per agent, honor the requested model/reasoning, and wait for prerequisite drafts before dispatching dependent work. Review the combined set for consistency.
   - Check acceptance coverage, dependency links, and formatting. Report paths and material scope questions; do not repeat settled decisions as approval questions.
   - Completion: the complete draft set is locally reviewable.

5. Publish when requested.
   - For explicit tracker creation or updates, follow [publishing](references/publishing.md) to reuse existing issues, resolve real IDs, and verify dependencies.
   - Completion: the requested issues are verified in the tracker, or specific failed operations are reported with successful work preserved.

## Issue template

```markdown
# Clear task title

## Description

State the user outcome and essential implementation context.

- Add only constraints needed to implement this outcome correctly.

Blocked by: linked prerequisite and the capability it provides.

## Acceptance criteria

- [ ] Given a concrete starting state, when the user acts, then an observable result occurs.
- [ ] Given the relevant failure or edge condition, when it occurs, then the expected recovery or protection holds.
```

Omit the blocker line when there are none. On GitHub, use the title field instead of repeating the title in the body.
