<script lang="ts">
  let { text }: { text: string } = $props();
</script>

<article class="mb-2 flex flex-col items-stretch">
  <div
    class="w-full rounded-none bg-secondary px-2 py-2 font-mono text-[12.5px] leading-[1.55] whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]"
  >
    {text}
  </div>
</article>
