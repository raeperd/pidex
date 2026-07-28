<script lang="ts">
  import { getAppShellContext } from "./_components/AppShellContext.svelte";
  import Icon from "./_components/Icon.svelte";

  const context = getAppShellContext();
</script>

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
