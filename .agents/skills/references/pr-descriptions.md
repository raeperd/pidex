# PR descriptions

Use when creating or updating a PR body. Write for a reviewer who has not read the conversation.

- Default to **Description** and **Verification**, like the concise issue format. Use short, flat bullets and plain sentences, with one source line per paragraph. Aim for 100–200 words; simple changes can be shorter. Preserve any required repository template fields.
- Lead Description with the concrete problem and resulting behavior. Add only details needed to assess the change, including material risks or limitations. Describe the final scope, not the work's chronology or a file-by-file inventory.
- Link the issue once when applicable. Use a closing reference only when this PR completes all acceptance criteria. For a partial or stacked PR, include its dependency PRs and remaining issue scope in a short bullet; omit these when irrelevant.
- Verification states what actually ran and its result. Prefer the user behavior or acceptance scenario checked, with exact commands or links to reproduction instructions and useful artifacts. State relevant checks not run and why; keep planned checks distinct from passing results.
- Keep review SHAs, bot activity, CI retry logs, and handoff details in the existing review record or dedicated handoff comment. Rewrite stale text as scope changes. Remove empty sections, placeholders, repeated rationale, and generic checklists; necessary evidence takes priority over the word target.
- Before publishing, read the body once for scope, short bullets, working links, and accurate verification. Read back the saved GitHub body to verify formatting and content.

```markdown
## Description

- <Problem and resulting behavior.>
- <Essential scope, constraint, or risk, if needed.>
- Refs #<issue>.

## Verification

- `<command>`: <actual result and behavior checked>.
```

Omit optional bullets and replace placeholders before posting. Use `Closes #<issue>` in place of `Refs` only for the final implementation PR described above.
