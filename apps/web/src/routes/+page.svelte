<script lang="ts">
  import type { ChatSnapshot } from "@pidex/api";
  import { getAppShellContext } from "./_components/AppShellContext.svelte";
  import type { TaskConfigurationPatch } from "./_components/AppShellContext.svelte";
  import ComposerModelControls from "./_components/ComposerModelControls.svelte";
  import HostUnavailable from "./_components/HostUnavailable.svelte";
  import Icon from "./_components/Icon.svelte";
  import {
    composerControlsClass,
    composerFooterClass,
    composerSendButtonClass,
    composerSurfaceClass,
    composerTextareaClass,
  } from "./_components/TaskComposer.svelte";

  interface StarterState {
    readonly draft: string;
    readonly modelOverride: string;
    readonly submitting: boolean;
    readonly thinkingLevel: ChatSnapshot["thinkingLevel"];
  }

  const context = getAppShellContext();
  const projectButtonClass =
    "cursor-pointer border-0 border-b border-dashed border-faint bg-transparent p-0 text-inherit transition-colors hover:border-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary";
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

{#if context.shell.bootstrapError && !context.shell.bootstrap}
  <section
    class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-smooth [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin] motion-reduce:scroll-auto"
  >
    <HostUnavailable />
  </section>
{:else if !context.shell.routeReady}
  <section class="min-h-0 flex-1 overflow-hidden" aria-label="Loading project" role="status">
    <span class="sr-only">Loading project…</span>
    <div
      class="mx-auto flex min-h-full w-full max-w-transcript animate-pulse flex-col justify-center gap-5 px-5 py-12 max-[560px]:gap-4 max-[560px]:px-3 max-[560px]:py-8"
      aria-hidden="true"
    >
      <div class="mx-auto h-9 w-3/5 max-w-105 rounded-full bg-border/70"></div>
      <div class="mx-auto h-35 w-full rounded-[20px] bg-secondary/75"></div>
    </div>
  </section>
{:else}
  {#key workspaceId}
    <section
      class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin]"
      aria-labelledby="starter-heading"
      data-testid="starter-composer"
    >
      <div
        class="mx-auto flex min-h-full w-full max-w-transcript flex-col justify-center gap-5 px-5 py-12 max-[560px]:gap-4 max-[560px]:px-3 max-[560px]:py-8"
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
                class={projectButtonClass}
                type="button"
                onclick={context.projectActions.openProjectPicker}
                aria-haspopup="dialog"
                title="Change project">{context.shell.workspace.name}</button
              >?</span
            >
          {:else}
            <button
              class={projectButtonClass}
              type="button"
              onclick={context.projectActions.openProjectPicker}
              aria-haspopup="dialog">Choose a project to start</button
            >
          {/if}
        </h1>
        <div class={composerSurfaceClass} data-testid="chat-composer">
          <textarea
            class={composerTextareaClass}
            value={starter.draft}
            oninput={(event) => draftInput(event.currentTarget)}
            onkeydown={keydown}
            rows="2"
            placeholder={context.shell.workspace
              ? "Ask Pi to work on this project…"
              : "Choose a project above to start a task"}
            disabled={!context.shell.workspace || starter.submitting}
            aria-label="Prompt"></textarea>
          <div class={composerFooterClass}>
            <div class={composerControlsClass}>
              <ComposerModelControls
                models={context.shell.workspace?.models ?? []}
                {selectedModel}
                thinkingLevel={starter.thinkingLevel}
                modelDisabled={!context.shell.workspace?.models.length || starter.submitting}
                thinkingDisabled={!context.shell.workspace || starter.submitting}
                onModel={(model) => stageConfiguration({ model })}
                onThinking={(thinkingLevel) => stageConfiguration({ thinkingLevel })}
              />
            </div>
            <button
              class={composerSendButtonClass}
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
{/if}
