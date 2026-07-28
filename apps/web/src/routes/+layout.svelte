<script lang="ts">
  import "@fontsource-variable/dm-sans/index.css";
  import "@fontsource/jetbrains-mono/400.css";
  import "../styles.css";
  import AppShell from "./_components/AppShell.svelte";

  let { children } = $props();
</script>

<AppShell />
{@render children()}
