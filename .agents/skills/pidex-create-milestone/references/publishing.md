# Publishing milestone descriptions with gh CLI

Use this workflow for requested GitHub milestone creation or updates. Prepare the complete description before writing, and reuse authorization already given in the conversation.

1. Resolve the repository and milestone.
   - Check the configured repository with `gh repo view --json nameWithOwner`. Use the repository from the request when it differs.
   - List all milestones with `gh api --paginate 'repos/OWNER/REPO/milestones?state=all&per_page=100'`. Match the intended title/version and scope; the API uses the milestone's `number`, not its `id`.
   - Read an existing milestone with `gh api repos/OWNER/REPO/milestones/NUMBER`. Save its description before editing. Preserve unrelated content, title, state, and due date unless their changes were requested.

2. Prepare the full description.
   - Write actual Markdown to `.scratch/<milestone-slug>/description.md`. Use this as a temporary publication artifact, not a second maintained spec.
   - When migrating an existing spec, remove its opening title heading because GitHub already displays the milestone title. Start with a plain-text summary, retain section headings, accepted decisions, and acceptance coverage, correct stale status claims using verified evidence, and convert relative links to absolute GitHub URLs.
   - Re-read the milestone before updating; reconcile intervening changes rather than overwriting them with an older draft.

3. Publish with a file-backed field.
   - Replace `OWNER`, `REPO`, `NUMBER`, `VERSION`, and `SLUG` below with resolved values. Run only the applicable update or create command.

   ```bash
   # Update an existing milestone's description.
   gh api --method PATCH repos/OWNER/REPO/milestones/NUMBER \
     --field description=@.scratch/SLUG/description.md

   # Create only when no matching milestone exists and creation is authorized.
   gh api --method POST repos/OWNER/REPO/milestones \
     --raw-field title='VERSION' \
     --field description=@.scratch/SLUG/description.md
   ```

   - `--field description=@...` reads the file and preserves Markdown/newlines without shell interpolation of its contents. Avoid embedding the description in shell arguments.
   - Record the returned number and URL. If creation has an uncertain result, query existing milestones before retrying. Stop and report persistent API or permission failures with the draft preserved.

4. Verify and report.
   - Fetch the milestone again and compare its full description with the prepared file; verify it begins with prose rather than a duplicate title heading, and that title, state, and due date changed only as intended.
   - For migrations, verify publication before replacing old repository specs with short links to the milestone. Keep durable repository guidance in docs.
   - Report the verified milestone URL. Issue publication is a separate requested operation through [pidex-create-issues](../../pidex-create-issues/SKILL.md).

References: [gh api](https://cli.github.com/manual/gh_api) for file-backed fields and pagination; [GitHub milestone API](https://docs.github.com/en/rest/issues/milestones) for create and update fields.
