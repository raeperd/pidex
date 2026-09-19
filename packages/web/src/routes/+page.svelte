<script lang="ts">
  let choosing = $state(false);
  let error = $state("");

  async function chooseProject() {
    choosing = true;
    error = "";
    try {
      await window.desktop.chooseProject();
    } catch {
      error = "Could not open the project. Please try again.";
    } finally {
      choosing = false;
    }
  }
</script>

<svelte:head>
  <title>pidex</title>
</svelte:head>

<main>
  <h1>pidex</h1>
  <button onclick={chooseProject} disabled={choosing}>Choose project</button>
  {#if error}<p role="alert">{error}</p>{/if}
</main>
