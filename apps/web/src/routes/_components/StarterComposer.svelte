<script lang="ts">
  import type { ChatSnapshot, Workspace } from "@pidex/api";
  import type { TaskConfigurationPatch } from "./AppShellContext.svelte";
  import Icon from "./Icon.svelte";

  let {
    start,
    workspace,
  }: {
    start: (draft: string, configuration: TaskConfigurationPatch) => Promise<void>;
    workspace: Workspace;
  } = $props();

  let draft = $state("");
  let modelOverride = $state("");
  let promptInput = $state<HTMLTextAreaElement>();
  let selectedThinkingLevel = $state<ChatSnapshot["thinkingLevel"]>("medium");
  let submitting = $state(false);
  let selectedModel = $derived(
    workspace.models.some(({ id }) => id === modelOverride)
      ? modelOverride
      : (workspace.models[0]?.id ?? ""),
  );

  async function send() {
    if (submitting || !draft.trim()) return;
    submitting = true;
    try {
      await start(draft, { model: selectedModel, thinkingLevel: selectedThinkingLevel });
    } finally {
      submitting = false;
    }
  }

  function stageConfiguration(patch: TaskConfigurationPatch) {
    if (patch.model !== undefined) modelOverride = patch.model;
    if (patch.thinkingLevel !== undefined) selectedThinkingLevel = patch.thinkingLevel;
  }

  function draftInput() {
    if (!promptInput) return;
    promptInput.style.height = "auto";
    promptInput.style.height = `${Math.min(promptInput.scrollHeight, 210)}px`;
  }

  function keydown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey && matchMedia("(min-width: 821px)").matches) {
      event.preventDefault();
      void send();
    }
  }
</script>

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
      What should we work on in {workspace.name}?
    </h1>
    <div class="chat-composer mx-auto" data-testid="chat-composer">
      <textarea
        class="chat-composer__input"
        bind:this={promptInput}
        bind:value={draft}
        oninput={draftInput}
        onkeydown={keydown}
        rows="2"
        placeholder="Ask Pi to work on this project…"
        aria-label="Prompt"></textarea>
      <div class="chat-composer__toolbar">
        <div class="chat-composer__controls">
          <label class="chat-composer__control">
            <select
              class="chat-composer__select"
              aria-label="Model"
              value={selectedModel}
              onchange={(event) => stageConfiguration({ model: event.currentTarget.value })}
              disabled={!workspace.models.length}
            >
              {#each workspace.models as model (model.id)}<option value={model.id}
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
              value={selectedThinkingLevel}
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
          disabled={!draft.trim() || !workspace.models.length || submitting}
          aria-label="Send"><Icon name="send" /></button
        >
      </div>
    </div>
  </div>
</section>
