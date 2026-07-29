<script lang="ts">
  import { page } from "$app/state";
  import {
    getAppShellContext,
    type TaskComposerController,
    type TaskTranscriptController,
  } from "../../_components/AppShellContext.svelte";
  import Icon from "../../_components/Icon.svelte";
  import TaskComposer from "../../_components/TaskComposer.svelte";
  import TaskTranscript from "./_components/TaskTranscript.svelte";

  const context = getAppShellContext();
  let taskId = $derived(page.params.taskId ?? "");
  let composerController = $state<TaskComposerController>();
  let transcriptController = $state<TaskTranscriptController>();

  function attachComposer(controller: TaskComposerController | undefined) {
    composerController = controller;
    context.taskActions.attachComposer(controller);
  }

  function attachTranscript(controller: TaskTranscriptController | undefined) {
    transcriptController = controller;
    context.taskActions.attachTranscript(controller);
  }
</script>

{#if taskId && context.task.snapshot}
  <TaskTranscript
    bind:this={() => transcriptController, attachTranscript}
    items={context.task.snapshot.items}
    transcriptStart={context.task.snapshot.transcriptStart}
    loadingEarlier={context.task.loadingEarlier}
    loadEarlier={context.taskActions.loadEarlier}
    loadToolOutput={context.taskActions.loadToolOutput}
    toolElapsedNow={context.task.toolElapsedNow}
    toolOutputs={context.task.toolOutputs}
    toolTimings={context.task.toolTimings}
  />
  <TaskComposer
    bind:this={() => composerController, attachComposer}
    bind:delivery={() => context.task.delivery, context.taskActions.setDelivery}
    bind:draft={() => context.task.draft, context.taskActions.setDraft}
    active={context.task.active}
    clearQueue={context.taskActions.clearQueue}
    commands={context.shell.workspace?.commands ?? []}
    compact={context.taskActions.compact}
    configure={context.taskActions.configure}
    connection={context.shell.connection}
    contextUsage={context.task.snapshot.contextUsage}
    creatingTask={context.task.creatingTask}
    followUpCount={context.task.snapshot.followUpQueue.length}
    models={context.shell.workspace?.models ?? []}
    persistDraft={context.taskActions.persistDraft}
    projectName={context.shell.workspace?.name ?? "Project"}
    requiresAcknowledgement={Boolean(context.task.snapshot.run?.requiresAcknowledgement)}
    runStatus={context.task.snapshot.runStatus}
    selectedModel={context.task.selectedModel}
    selectedThinkingLevel={context.task.selectedThinkingLevel}
    send={context.taskActions.send}
    setStartMode={context.taskActions.setStartMode}
    startMode={context.task.startMode}
    startModeEditable={context.task.startModeEditable}
    steeringCount={context.task.snapshot.steeringQueue.length}
    stop={context.taskActions.stop}
    {taskId}
  />
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
    {:else if context.shell.routeLoading}
      <div
        class="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 px-5 pt-10 pb-12 max-[900px]:px-4"
        aria-label="Loading task"
        role="status"
      >
        <span class="sr-only">Loading task…</span>
        {#each ["w-2/5", "w-4/5", "w-3/5"] as width, index (width)}
          <div class={`animate-pulse ${index === 1 ? "ml-auto" : ""} ${width}`}>
            <div class="mb-2 h-2.5 w-20 rounded-full bg-border"></div>
            <div class="h-20 rounded-2xl bg-secondary/75"></div>
          </div>
        {/each}
      </div>
    {:else if !context.shell.workspace}
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
    {:else}
      <div
        class="flex min-h-full w-full flex-col items-center justify-center px-6 pb-16 text-center max-[560px]:px-4.5"
        role="status"
      >
        <h1 class="m-0 text-xl font-semibold tracking-tight text-foreground">
          Pick a task to continue
        </h1>
        <p class="mt-2 text-sm leading-relaxed text-muted">
          Select an existing task or create a new one to get started.
        </p>
      </div>
    {/if}
  </section>
{/if}
