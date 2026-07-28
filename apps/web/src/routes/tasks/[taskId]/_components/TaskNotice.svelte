<script lang="ts">
  import Icon from "../../../_components/Icon.svelte";

  let { level, text }: { level: "error" | "info" | "warning"; text: string } = $props();
</script>

<div
  class={`mx-1 my-2.5 flex items-start gap-2 rounded-lg border bg-secondary/45 px-3 py-2 text-[11.5px] leading-relaxed ${level === "error" ? "border-danger/25 text-danger" : "border-border text-muted"}`}
>
  <span class="mt-px flex-none text-primary"><Icon name="activity" size={14} /></span><span
    >{text}</span
  >
</div>
