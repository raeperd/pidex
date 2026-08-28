<script lang="ts">
  import Icon from "../../../_components/Icon.svelte";

  let { level, text }: { level: "error" | "info" | "warning"; text: string } = $props();
</script>

<div
  class={`mx-1 my-2.5 flex items-start gap-2 rounded-lg border bg-secondary/45 px-3 py-2 text-control leading-relaxed ${
    level === "error"
      ? "border-danger/25 text-danger"
      : level === "warning"
        ? "border-warning/25 text-warning-text"
        : "border-border text-muted"
  }`}
>
  <span
    class={`mt-px flex-none ${level === "error" ? "text-danger" : level === "warning" ? "text-warning-text" : "text-primary-text"}`}
    ><Icon name="activity" size={14} /></span
  ><span>{text}</span>
</div>
