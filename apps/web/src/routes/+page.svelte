<script lang="ts">
  import type { ChatSnapshot } from "@pidex/api";
  import { getAppShellContext } from "./_components/AppShellContext.svelte";
  import type { TaskConfigurationPatch } from "./_components/AppShellContext.svelte";
  import Icon from "./_components/Icon.svelte";
  import StartModeSelector from "./_components/StartModeSelector.svelte";

  const composerSelectLabelClass =
    "flex h-7.5 min-w-0 flex-none items-center gap-1.5 overflow-hidden rounded-lg pl-2 text-muted transition-colors duration-[140ms] hover:bg-secondary hover:text-foreground focus-within:bg-secondary focus-within:text-foreground max-[560px]:h-9 max-[560px]:gap-1 max-[560px]:pl-1.5";
  const composerSelectClass =
    "h-full max-w-44 min-w-0 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap border-0 border-none bg-transparent pr-5 text-control font-semibold text-inherit outline-none disabled:cursor-not-allowed disabled:opacity-42 max-[560px]:pr-3.5 max-[560px]:text-control [@supports(appearance:base-select)]:flex [@supports(appearance:base-select)]:items-center [@supports(appearance:base-select)]:gap-1.5 [@supports(appearance:base-select)]:pr-1.5 [@supports(appearance:base-select)]:[appearance:base-select] [@supports(appearance:base-select)]:[&::picker(select)]:[appearance:base-select] [@supports(appearance:base-select)]:[&::picker(select)]:max-h-[min(22rem,calc(100dvh-2rem))] [@supports(appearance:base-select)]:[&::picker(select)]:overflow-y-auto [@supports(appearance:base-select)]:[&::picker(select)]:[position-area:block-start_span-inline-end] [@supports(appearance:base-select)]:[&::picker(select)]:[position-try-fallbacks:flip-block] [@supports(appearance:base-select)]:[&::picker(select)]:mb-2 [@supports(appearance:base-select)]:[&::picker(select)]:rounded-xl [@supports(appearance:base-select)]:[&::picker(select)]:border [@supports(appearance:base-select)]:[&::picker(select)]:border-border-strong [@supports(appearance:base-select)]:[&::picker(select)]:bg-card [@supports(appearance:base-select)]:[&::picker(select)]:p-1 [@supports(appearance:base-select)]:[&::picker(select)]:text-foreground [@supports(appearance:base-select)]:[&::picker(select)]:shadow-[0_18px_48px_rgb(0_0_0/24%)] [@supports(appearance:base-select)]:[&::picker(select)]:[scrollbar-width:thin] [@supports(appearance:base-select)]:[&::picker-icon]:size-3 [@supports(appearance:base-select)]:[&::picker-icon]:ml-0.5 [@supports(appearance:base-select)]:[&::picker-icon]:text-faint [@supports(appearance:base-select)]:[&::picker-icon]:transition-[rotate] [@supports(appearance:base-select)]:[&::picker-icon]:duration-[140ms] [@supports(appearance:base-select)]:[&::picker-icon]:ease-[ease] [@supports(appearance:base-select)]:[&:open::picker-icon]:rotate-180 [@supports(appearance:base-select)]:[&_option]:flex [@supports(appearance:base-select)]:[&_option]:min-h-8 [@supports(appearance:base-select)]:[&_option]:items-center [@supports(appearance:base-select)]:[&_option]:rounded-lg [@supports(appearance:base-select)]:[&_option]:px-2 [@supports(appearance:base-select)]:[&_option]:py-[0.45rem] [@supports(appearance:base-select)]:[&_option]:text-xs [@supports(appearance:base-select)]:[&_option]:font-medium [@supports(appearance:base-select)]:[&_option]:text-muted [@supports(appearance:base-select)]:[&_option]:cursor-pointer [@supports(appearance:base-select)]:[&_option:hover]:bg-secondary [@supports(appearance:base-select)]:[&_option:hover]:text-foreground [@supports(appearance:base-select)]:[&_option:focus-visible]:bg-secondary [@supports(appearance:base-select)]:[&_option:focus-visible]:text-foreground [@supports(appearance:base-select)]:[&_option:checked]:bg-[color-mix(in_srgb,var(--primary)_12%,var(--secondary))] [@supports(appearance:base-select)]:[&_option:checked]:font-[650] [@supports(appearance:base-select)]:[&_option:checked]:text-foreground [@supports(appearance:base-select)]:[&_option::checkmark]:order-1 [@supports(appearance:base-select)]:[&_option::checkmark]:ml-auto [@supports(appearance:base-select)]:[&_option::checkmark]:text-primary";

  interface StarterState {
    readonly draft: string;
    readonly modelOverride: string;
    readonly submitting: boolean;
    readonly thinkingLevel: ChatSnapshot["thinkingLevel"];
  }

  const context = getAppShellContext();
  const defaultStarter: StarterState = {
    draft: "",
    modelOverride: "",
    submitting: false,
    thinkingLevel: "medium",
  };
  let starters = $state<Record<string, StarterState>>({});
  let workspaceId = $derived(context.shell.workspace?.id ?? "");
  let starter = $derived(starters[workspaceId] ?? defaultStarter);
  let selectedModel = $derived(
    context.shell.workspace?.models.some(({ id }) => id === starter.modelOverride)
      ? starter.modelOverride
      : (context.shell.workspace?.models[0]?.id ?? ""),
  );

  async function send() {
    const submittedWorkspaceId = workspaceId;
    const submittedDraft = starter.draft;
    if (!context.shell.workspace) {
      context.projectActions.openProjectPicker();
      return;
    }
    if (starter.submitting || !submittedDraft.trim() || !selectedModel) return;
    updateStarter({ submitting: true }, submittedWorkspaceId);
    try {
      await context.taskActions.start(submittedDraft, {
        model: selectedModel,
        thinkingLevel: starter.thinkingLevel,
      });
    } finally {
      updateStarter({ submitting: false }, submittedWorkspaceId);
    }
  }

  function stageConfiguration(patch: TaskConfigurationPatch) {
    updateStarter({
      ...(patch.model === undefined ? {} : { modelOverride: patch.model }),
      ...(patch.thinkingLevel === undefined ? {} : { thinkingLevel: patch.thinkingLevel }),
    });
  }

  function updateStarter(patch: Partial<StarterState>, targetWorkspaceId = workspaceId) {
    starters[targetWorkspaceId] = { ...(starters[targetWorkspaceId] ?? defaultStarter), ...patch };
  }

  function draftInput(input: HTMLTextAreaElement) {
    updateStarter({ draft: input.value });
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 210)}px`;
  }

  function keydown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey && matchMedia("(min-width: 821px)").matches) {
      event.preventDefault();
      void send();
    }
  }
</script>

{#if !context.shell.routeReady && !(context.shell.bootstrapError && !context.shell.bootstrap)}
  <section class="min-h-0 flex-1 overflow-hidden" aria-label="Loading project" role="status">
    <span class="sr-only">Loading project…</span>
    <div
      class="mx-auto flex min-h-full w-full max-w-3xl animate-pulse flex-col justify-center gap-5 px-5 py-12 max-[560px]:gap-4 max-[560px]:px-3 max-[560px]:py-8"
      aria-hidden="true"
    >
      <div class="mx-auto h-9 w-3/5 max-w-105 rounded-full bg-border/70"></div>
      <div class="mx-auto h-35 w-full rounded-[20px] bg-secondary/75"></div>
    </div>
  </section>
{:else if !(context.shell.bootstrapError && !context.shell.bootstrap)}
  {#key workspaceId}
    <section
      class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin]"
      aria-labelledby="starter-heading"
      data-testid="starter-composer"
    >
      <div
        class="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-5 px-5 py-12 max-[560px]:gap-4 max-[560px]:px-3 max-[560px]:py-8"
      >
        <h1
          class="m-0 text-center text-display font-semibold tracking-tight text-foreground max-[560px]:text-title"
          id="starter-heading"
          aria-label={context.shell.workspace
            ? `What should we work on in ${context.shell.workspace.name}?`
            : "Choose a project to start"}
        >
          {#if context.shell.workspace}
            What should we work on in <span class="inline-block"
              ><button
                class="cursor-pointer border-0 border-b border-dashed border-faint bg-transparent p-0 text-inherit transition-colors hover:border-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
                type="button"
                onclick={context.projectActions.openProjectPicker}
                aria-haspopup="dialog"
                title="Change project">{context.shell.workspace.name}</button
              >?</span
            >
          {:else}
            <button
              class="cursor-pointer border-0 border-b border-dashed border-faint bg-transparent p-0 text-inherit transition-colors hover:border-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
              type="button"
              onclick={context.projectActions.openProjectPicker}
              aria-haspopup="dialog">Choose a project to start</button
            >
          {/if}
        </h1>
        <div
          class="relative mx-auto w-full max-w-3xl overflow-visible rounded-composer border border-border-strong bg-[color-mix(in_srgb,var(--card)_96%,transparent)] shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)] transition-[border-color,box-shadow,background-color] duration-[160ms] focus-within:border-[color-mix(in_srgb,var(--primary)_78%,var(--border-strong))] focus-within:shadow-[0_16px_40px_-22px_rgb(24_24_27/55%),0_0_0_3px_color-mix(in_srgb,var(--primary)_9%,transparent)] dark:bg-[color-mix(in_srgb,var(--card)_92%,transparent)] dark:shadow-[inset_0_1px_rgb(255_255_255/3%)] dark:focus-within:shadow-[inset_0_1px_rgb(255_255_255/3%),0_0_0_3px_color-mix(in_srgb,var(--primary)_11%,transparent)]"
          data-testid="chat-composer"
        >
          <textarea
            class="block min-h-18 max-h-52 w-full resize-none border-0 border-none bg-transparent px-4.5 pt-4 pb-2 text-sm leading-[1.5] text-foreground outline-none placeholder:text-faint max-[560px]:min-h-16 max-[560px]:px-3.5 max-[560px]:pt-3.5 max-[560px]:pb-1.5 max-[560px]:text-base"
            value={starter.draft}
            oninput={(event) => draftInput(event.currentTarget)}
            onkeydown={keydown}
            rows="2"
            placeholder={context.shell.workspace
              ? "Ask Pi to work on this project…"
              : "Choose a project above to start a task"}
            disabled={!context.shell.workspace || starter.submitting}
            aria-label="Prompt"></textarea>
          <div
            class="flex min-h-11.5 min-w-0 items-center justify-between gap-2.5 pt-0.5 pr-2.5 pb-2.5 pl-3 max-[560px]:min-h-10.5 max-[560px]:items-end max-[560px]:pr-1.75 max-[560px]:pb-1.75 max-[560px]:pl-2"
          >
            <div class="flex min-w-0 flex-1 items-center gap-1 max-[560px]:gap-0">
              {#if context.task.startModeEditable || starter.submitting}
                <StartModeSelector
                  editable={context.task.startModeEditable}
                  initializeGit={context.projectActions.initializeGit}
                  mode={context.task.startMode}
                  pending={starter.submitting}
                  select={context.taskActions.setStartMode}
                  worktreeSupport={context.task.worktreeSupport}
                />
                <span
                  class="mx-0.5 h-4 w-px flex-none bg-border max-[560px]:mx-0"
                  aria-hidden="true"
                ></span>
              {/if}
              <div
                class="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-[560px]:gap-0"
              >
                <label class={composerSelectLabelClass}>
                  <select
                    class={[
                      composerSelectClass,
                      "max-[560px]:w-36 max-[560px]:max-w-36 [@supports(appearance:base-select)]:[&::picker(select)]:min-w-56",
                    ]}
                    aria-label="Model"
                    value={selectedModel}
                    onchange={(event) => stageConfiguration({ model: event.currentTarget.value })}
                    disabled={!context.shell.workspace?.models.length || starter.submitting}
                  >
                    {#each context.shell.workspace?.models ?? [] as model (model.id)}<option
                        value={model.id}>{model.name}</option
                      >{/each}
                  </select>
                </label>
                <span
                  class="mx-0.5 h-4 w-px flex-none bg-border max-[560px]:mx-0"
                  aria-hidden="true"
                ></span>
                <label class={composerSelectLabelClass}>
                  <span
                    class="grid w-4 flex-none place-items-center text-current max-[560px]:hidden"
                    aria-hidden="true"><Icon name="activity" size={14} /></span
                  >
                  <select
                    class={[
                      composerSelectClass,
                      "max-[560px]:max-w-27 [@supports(appearance:base-select)]:[&::picker(select)]:min-w-36",
                    ]}
                    aria-label="Thinking level"
                    value={starter.thinkingLevel}
                    onchange={(event) =>
                      stageConfiguration({
                        thinkingLevel: event.currentTarget.value as ChatSnapshot["thinkingLevel"],
                      })}
                    disabled={!context.shell.workspace || starter.submitting}
                  >
                    <option value="off">Off</option><option value="minimal">Minimal</option><option
                      value="low">Low</option
                    ><option value="medium">Medium</option><option value="high">High</option><option
                      value="xhigh">Extra high</option
                    ><option value="max">Max</option>
                  </select>
                </label>
              </div>
            </div>
            <button
              class="inline-grid size-8.5 flex-none place-items-center rounded-full border-0 border-none bg-primary text-primary-foreground shadow-[0_4px_12px_color-mix(in_srgb,var(--primary)_24%,transparent)] transition-[background-color,box-shadow,transform,opacity] duration-[140ms] hover:not-disabled:-translate-y-px hover:not-disabled:bg-primary-hover hover:not-disabled:shadow-[0_6px_16px_color-mix(in_srgb,var(--primary)_34%,transparent)] active:not-disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-35 disabled:shadow-none"
              onclick={send}
              disabled={!starter.draft.trim() ||
                !context.shell.workspace?.models.length ||
                starter.submitting}
              aria-label="Send"><Icon name="send" /></button
            >
          </div>
        </div>
      </div>
    </section>
  {/key}
{:else}
  <section
    class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-smooth [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin] motion-reduce:scroll-auto"
    role="log"
    aria-live="polite"
    aria-relevant="additions text"
  >
    <div
      class="flex min-h-full w-full flex-col items-center justify-center px-6 pt-12 pb-30 text-center max-[560px]:px-4.5"
      role="status"
    >
      <div
        class="relative mb-5 grid size-12 place-items-center rounded-2xl border border-border bg-card shadow-[var(--shadow)] before:absolute before:-inset-2 before:rounded-[20px] before:border before:border-border/60 before:content-['']"
      >
        <Icon name="activity" size={22} />
      </div>
      <p
        class="m-0 mb-2.5 font-mono text-meta leading-none font-semibold tracking-widest text-faint uppercase"
      >
        HOST UNAVAILABLE
      </p>
      <h1
        class="m-0 max-w-175 text-[clamp(27px,3vw,38px)] leading-tight font-normal tracking-tighter text-foreground max-[560px]:text-[27px]"
      >
        Your projects are still on the desktop.
      </h1>
      <p class="mt-3 max-w-125 text-sm leading-relaxed text-muted">
        Pidex could not reach its local host. Nothing was deleted and no draft will be submitted
        automatically.
      </p>
      <button
        class="mt-5.5 rounded-lg border border-border-strong bg-card px-3.5 py-2 text-xs font-semibold text-foreground shadow-[var(--shadow)] disabled:opacity-40"
        onclick={context.projectActions.retryConnection}
        disabled={context.shell.retryingConnection}
        >{context.shell.retryingConnection ? "Retrying…" : "Retry connection"}</button
      >
    </div>
  </section>
{/if}
