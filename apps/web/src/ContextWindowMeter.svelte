<script lang="ts">
  import type { ContextUsage } from "@pidex/api";

  const RADIUS = 9.75;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  let { usage }: { usage: ContextUsage } = $props();
  const componentId = $props.id();
  const detailsId = `${componentId}-details`;

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

<div class="context-meter">
  <button
    class="context-meter__trigger"
    type="button"
    aria-label={ariaLabel}
    aria-describedby={detailsId}
  >
    <svg class="context-meter__ring" viewBox="0 0 24 24" aria-hidden="true">
      <circle class="context-meter__track" cx="12" cy="12" r={RADIUS} />
      <circle
        class={["context-meter__progress", overloaded && "context-meter__progress--danger"]}
        cx="12"
        cy="12"
        r={RADIUS}
        stroke-dasharray={CIRCUMFERENCE}
        stroke-dashoffset={dashOffset}
      />
    </svg>
  </button>

  <div class="context-meter__popover" id={detailsId} role="tooltip">
    <div class="context-meter__heading">
      <strong>Context Window</strong>
      {#if percentageLabel}
        <span
          >{percentageLabel} · {formatTokens(usage.tokens)}/{formatTokens(
            usage.contextWindow,
          )}</span
        >
      {:else}
        <span>{formatTokens(usage.tokens)}/{formatTokens(usage.contextWindow)}</span>
      {/if}
    </div>
    <div
      class="context-meter__bar"
      role="progressbar"
      aria-label="Context window usage"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={usage.percent === null ? undefined : Math.round(normalizedPercent)}
    >
      <span
        class={["context-meter__bar-fill", overloaded && "context-meter__bar-fill--danger"]}
        style:width={`${normalizedPercent}%`}
      ></span>
    </div>
    <div class="context-meter__processed">
      <span>Total processed</span><strong>{formatTokens(usage.totalProcessedTokens)}</strong>
    </div>
    {#if usage.compactsAutomatically}
      <p>Pi automatically compacts its context when needed.</p>
    {/if}
  </div>
</div>

<style>
  .context-meter {
    position: relative;
    display: inline-flex;
    flex: none;
  }

  .context-meter__trigger {
    display: inline-grid;
    width: 2rem;
    height: 2rem;
    place-items: center;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--primary);
    transition: background-color 140ms ease;
  }

  .context-meter__trigger:hover,
  .context-meter__trigger:focus-visible {
    background: var(--secondary);
  }

  .context-meter__ring {
    width: 1.125rem;
    height: 1.125rem;
    rotate: -90deg;
  }

  .context-meter__track,
  .context-meter__progress {
    fill: none;
    stroke-width: 3;
  }

  .context-meter__track {
    stroke: color-mix(in srgb, var(--faint) 26%, transparent);
  }

  .context-meter__progress {
    stroke: currentColor;
    stroke-linecap: round;
    transition: stroke-dashoffset 500ms ease-out;
  }

  .context-meter__progress--danger {
    stroke: var(--danger);
  }

  .context-meter__popover {
    position: absolute;
    right: 0;
    bottom: calc(100% + 0.625rem);
    z-index: 20;
    display: grid;
    width: 16rem;
    gap: 0.625rem;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--card) 96%, transparent);
    box-shadow: 0 18px 48px rgb(0 0 0 / 24%);
    color: var(--muted);
    font-size: 0.6875rem;
    line-height: 1.4;
    opacity: 0;
    pointer-events: none;
    translate: 0 0.25rem;
    transition:
      opacity 120ms ease 0ms,
      translate 120ms ease 0ms;
  }

  .context-meter:hover .context-meter__popover,
  .context-meter:focus-within .context-meter__popover {
    opacity: 1;
    translate: 0 0;
    transition-delay: 150ms;
  }

  .context-meter__heading,
  .context-meter__processed {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .context-meter__heading strong,
  .context-meter__processed strong {
    color: var(--muted);
    font-weight: 600;
  }

  .context-meter__heading span,
  .context-meter__processed strong {
    font-family: var(--mono);
    font-size: 0.625rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .context-meter__bar {
    height: 0.375rem;
    overflow: hidden;
    border-radius: 999px;
    background: color-mix(in srgb, var(--faint) 18%, transparent);
  }

  .context-meter__bar-fill {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--primary);
    transition: width 500ms ease-out;
  }

  .context-meter__bar-fill--danger {
    background: var(--danger);
  }

  .context-meter__processed span {
    color: var(--faint);
  }

  .context-meter__popover p {
    margin: 0.125rem 0 0;
    color: var(--faint);
  }

  @media (prefers-reduced-motion: reduce) {
    .context-meter__progress,
    .context-meter__bar-fill,
    .context-meter__popover {
      transition: none;
    }
  }
</style>
