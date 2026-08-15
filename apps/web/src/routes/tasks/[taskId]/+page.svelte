<script lang="ts">
  import { page } from "$app/state";
  import {
    getAppShellContext,
    type TaskComposerController,
    type TaskTranscriptController,
  } from "../../_components/AppShellContext.svelte";
  import HostUnavailable, {
    heroBadgeClass,
    heroButtonClass,
    heroClass,
    heroKickerClass,
    heroLeadClass,
    heroTitleClass,
  } from "../../_components/HostUnavailable.svelte";
  import TaskComposer from "../../_components/TaskComposer.svelte";
  import TaskTranscript from "./_components/TaskTranscript.svelte";

  const context = getAppShellContext();
  let taskId = $derived(page.params.taskId ?? "");
  // Track the bound instances so Svelte can detach them from the registry on teardown:
  // a getter that always returns undefined would never match the destroyed instance.
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
    bind:draft={() => context.task.draft, context.taskActions.setDraft}
    active={context.task.active}
    clearQueue={context.taskActions.clearQueue}
    commands={context.shell.workspace?.commands ?? []}
    compact={context.taskActions.compact}
    compactPending={context.task.compactPending}
    configure={context.taskActions.configure}
    configurationPending={context.task.configurationPending}
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
    taskId={context.task.snapshot.taskId}
  />
{:else}
  <section
    class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-smooth [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin] motion-reduce:scroll-auto"
  >
    {#if context.shell.bootstrapError && !context.shell.bootstrap}
      <HostUnavailable />
    {:else if context.shell.routeLoading}
      <div
        class="mx-auto flex min-h-full w-full max-w-transcript flex-col gap-6 px-5 pt-10 pb-12 max-[900px]:px-4"
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
      <div class={heroClass}>
        <div class={heroBadgeClass}>
          <span class="font-serif text-[26px] leading-none font-bold">π</span>
        </div>
        <p class={heroKickerClass}>YOUR PRIVATE PI PROJECT</p>
        <h1 class={heroTitleClass}>Bring Pi with you.</h1>
        <p class={heroLeadClass}>Choose a project to create or resume a task.</p>
        <button
          class={`mt-4.5 ${heroButtonClass}`}
          onclick={context.projectActions.openProjectPicker}>Add a project</button
        >
      </div>
    {:else}
      <div
        class="flex min-h-full w-full flex-col items-center justify-center px-6 pb-16 text-center max-[560px]:px-4.5"
        role="status"
      >
        <h1 class="m-0 text-title font-semibold tracking-tight text-foreground">
          Pick a task to continue
        </h1>
        <p class="mt-2 text-ui leading-relaxed text-muted">
          Select an existing task or create a new one to get started.
        </p>
      </div>
    {/if}
  </section>
{/if}
