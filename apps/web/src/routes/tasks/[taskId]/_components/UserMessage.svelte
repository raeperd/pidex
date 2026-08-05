<script lang="ts">
  let { text }: { text: string } = $props();
</script>

<article class="my-6 flex flex-col items-end px-2">
  <div
    class="w-fit max-w-[85%] rounded-composer border border-border-strong bg-secondary px-4 py-3 font-sans text-ui leading-[1.55] font-medium whitespace-pre-wrap text-foreground [overflow-wrap:anywhere] max-[560px]:max-w-[92%] max-[560px]:px-3.5 max-[560px]:py-2.5"
  >
    {text}
  </div>
</article>
