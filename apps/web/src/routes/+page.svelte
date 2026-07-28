<script lang="ts">
  import type { ChatSnapshot } from "@pidex/api";
  import { getAppShellContext } from "./_components/AppShellContext.svelte";
  import type { TaskConfigurationPatch } from "./_components/AppShellContext.svelte";
  import Icon from "./_components/Icon.svelte";

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

{#if context.shell.workspace && !(context.shell.bootstrapError && !context.shell.bootstrap)}
  {#key context.shell.workspace.id}
    <section
      class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin]"
      aria-labelledby="starter-heading"
      data-testid="starter-composer"
    >
      <div
        class="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-5 px-5 py-12 max-[560px]:gap-4 max-[560px]:px-3 max-[560px]:py-8"
      >
        <h1
          class="m-0 text-center text-[clamp(25px,3vw,36px)] leading-tight font-normal tracking-tighter text-foreground max-[560px]:text-[25px]"
          id="starter-heading"
        >
          What should we work on in {context.shell.workspace.name}?
        </h1>
        <div class="chat-composer mx-auto" data-testid="chat-composer">
          <textarea
            class="chat-composer__input"
            value={starter.draft}
            oninput={(event) => draftInput(event.currentTarget)}
            onkeydown={keydown}
            rows="2"
            placeholder="Ask Pi to work on this project…"
            disabled={starter.submitting}
            aria-label="Prompt"></textarea>
          <div class="chat-composer__toolbar">
            <div class="chat-composer__controls">
              <label class="chat-composer__control">
                <select
                  class="chat-composer__select"
                  aria-label="Model"
                  value={selectedModel}
                  onchange={(event) => stageConfiguration({ model: event.currentTarget.value })}
                  disabled={!context.shell.workspace.models.length}
                >
                  {#each context.shell.workspace.models as model (model.id)}<option value={model.id}
                      >{model.name}</option
                    >{/each}
                </select>
              </label>
              <span class="chat-composer__divider" aria-hidden="true"></span>
              <label class="chat-composer__control">
                <span class="chat-composer__control-icon" aria-hidden="true"
                  ><Icon name="activity" size={14} /></span
                >
                <select
                  class="chat-composer__select"
                  aria-label="Thinking level"
                  value={starter.thinkingLevel}
                  onchange={(event) =>
                    stageConfiguration({
                      thinkingLevel: event.currentTarget.value as ChatSnapshot["thinkingLevel"],
                    })}
                >
                  <option value="off">Off</option><option value="minimal">Minimal</option><option
                    value="low">Low</option
                  ><option value="medium">Medium</option><option value="high">High</option><option
                    value="xhigh">Extra high</option
                  ><option value="max">Max</option>
                </select>
              </label>
            </div>
            <button
              class="chat-composer__send"
              onclick={send}
              disabled={!starter.draft.trim() ||
                !context.shell.workspace.models.length ||
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
    {#if context.shell.bootstrapError && !context.shell.bootstrap}
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
          class="m-0 mb-2.5 font-mono text-[10px] leading-none font-semibold tracking-widest text-faint uppercase"
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
    {:else}
      <div
        class="flex min-h-full w-full flex-col items-center justify-center px-6 pt-12 pb-30 text-center max-[560px]:px-4.5"
      >
        <div
          class="relative mb-5 grid size-12 place-items-center rounded-2xl border border-border bg-card shadow-[var(--shadow)] before:absolute before:-inset-2 before:rounded-[20px] before:border before:border-border/60 before:content-['']"
        >
          <span class="font-serif text-[26px] leading-none font-bold">π</span>
        </div>
        <p
          class="m-0 mb-2.5 font-mono text-[10px] leading-none font-semibold tracking-widest text-faint uppercase"
        >
          YOUR PRIVATE PI PROJECT
        </p>
        <h1
          class="m-0 max-w-175 text-[clamp(27px,3vw,38px)] leading-tight font-normal tracking-tighter text-foreground max-[560px]:text-[27px]"
        >
          Bring Pi with you.
        </h1>
        <p class="mt-3 max-w-125 text-sm leading-relaxed text-muted">
          Choose a project to create or resume a task.
        </p>
        <button
          class="mt-4.5 rounded-lg border border-border-strong bg-card px-3.5 py-2 text-xs font-semibold text-foreground shadow-[var(--shadow)]"
          onclick={context.projectActions.openProjectPicker}>Add a project</button
        >
      </div>
    {/if}
  </section>
{/if}
