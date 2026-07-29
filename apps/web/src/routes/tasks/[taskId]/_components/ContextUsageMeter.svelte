<script lang="ts">
  import type { ContextUsage } from "@pidex/api";

  const RADIUS = 9.75;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  let { usage }: { usage: ContextUsage } = $props();

  let normalizedPercent = $derived(Math.max(0, Math.min(100, usage.percent ?? 0)));
  let percentageLabel = $derived(formatPercentage(usage.percent));
  let dashOffset = $derived(CIRCUMFERENCE * (1 - normalizedPercent / 100));
  let overloaded = $derived(normalizedPercent > 90);
  let ariaLabel = $derived(
    percentageLabel
      ? `Context window ${percentageLabel} used`
      : "Context window usage is being calculated",
  );

  function formatPercentage(value: number | null) {
    if (value === null || !Number.isFinite(value)) return null;
    return value < 10 ? `${value.toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(value)}%`;
  }

  function formatTokens(value: number | null) {
    if (value === null || !Number.isFinite(value)) return "Calculating";
    if (value < 1_000) return `${Math.round(value)}`;
    if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
    if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  }
</script>

<div class="context-meter relative inline-flex flex-none">
  <span
    class="context-meter__trigger inline-grid size-8 place-items-center rounded-[999px] bg-transparent text-primary"
    role="img"
    aria-label={ariaLabel}
    title="Context window usage"
  >
    <svg class="size-4.5 [rotate:-90deg]" viewBox="0 0 24 24" aria-hidden="true">
      <circle
        class="fill-none [stroke-width:3] [stroke:color-mix(in_srgb,var(--faint)_26%,transparent)]"
        cx="12"
        cy="12"
        r={RADIUS}
      />
      <circle
        class={[
          "fill-none [stroke-linecap:round] [stroke-width:3] transition-[stroke-dashoffset] duration-500 ease-[ease-out] motion-reduce:transition-none",
          overloaded ? "stroke-danger" : "stroke-current",
        ]}
        cx="12"
        cy="12"
        r={RADIUS}
        stroke-dasharray={CIRCUMFERENCE}
        stroke-dashoffset={dashOffset}
      />
    </svg>
  </span>

  <div
    class="pointer-events-none absolute right-0 bottom-[calc(100%+0.625rem)] z-20 grid w-64 translate-y-1 gap-2.5 rounded-xl border border-border bg-[color-mix(in_srgb,var(--card)_96%,transparent)] p-3 text-[11px] leading-[1.4] text-muted opacity-0 shadow-[0_18px_48px_rgb(0_0_0/24%)] transition-[opacity,translate] delay-0 duration-[120ms] ease-[ease] [.context-meter:hover_&]:translate-y-0 [.context-meter:hover_&]:opacity-100 [.context-meter:hover_&]:delay-150 motion-reduce:transition-none"
    role="tooltip"
  >
    <div class="flex items-center justify-between gap-3">
      <strong class="font-semibold text-muted">Context Window</strong>
      {#if percentageLabel}
        <span class="font-mono text-[10px] whitespace-nowrap tabular-nums"
          >{percentageLabel} · {formatTokens(usage.tokens)}/{formatTokens(
            usage.contextWindow,
          )}</span
        >
      {:else}
        <span class="font-mono text-[10px] whitespace-nowrap tabular-nums"
          >{formatTokens(usage.tokens)}/{formatTokens(usage.contextWindow)}</span
        >
      {/if}
    </div>
    <div
      class="h-1.5 overflow-hidden rounded-[999px] bg-[color-mix(in_srgb,var(--faint)_18%,transparent)]"
      role="progressbar"
      aria-label="Context window usage"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={usage.percent === null ? undefined : Math.round(normalizedPercent)}
    >
      <span
        class={[
          "block h-full rounded-[inherit] transition-[width] duration-500 ease-[ease-out] motion-reduce:transition-none",
          overloaded ? "bg-danger" : "bg-primary",
        ]}
        style:width={`${normalizedPercent}%`}
      ></span>
    </div>
    <div class="flex items-center justify-between gap-3">
      <span class="text-faint">Total processed</span><strong
        class="font-mono text-[10px] font-semibold whitespace-nowrap text-muted tabular-nums"
        >{formatTokens(usage.totalProcessedTokens)}</strong
      >
    </div>
    {#if usage.compactsAutomatically}
      <p class="mt-0.5 mb-0 text-faint">Pi automatically compacts its context when needed.</p>
    {/if}
  </div>
</div>
