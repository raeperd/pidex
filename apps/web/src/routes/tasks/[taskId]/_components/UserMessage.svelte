<script lang="ts">
  let { text }: { text: string } = $props();
</script>

<article class="mb-5 flex flex-col items-end pt-1">
  <div
    class="max-w-4/5 rounded-2xl bg-secondary px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap text-foreground [overflow-wrap:anywhere] max-[560px]:max-w-9/10"
  >
    {text}
  </div>
</article>
