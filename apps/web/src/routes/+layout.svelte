<script lang="ts">
  import "@fontsource-variable/dm-sans/index.css";
  import "@fontsource/jetbrains-mono/400.css";
  import "../styles.css";
  import App from "../App.svelte";

  let { children } = $props();
</script>

<App />
{@render children()}
