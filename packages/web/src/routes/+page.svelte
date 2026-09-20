<script module lang="ts">
  import { marked } from "marked";
  import DOMPurify from "dompurify";

  function createMarkdownRenderer() {
    const cache = new Map<string, { text: string; html: string }>();
    return (id: string, text: string) => {
      const previous = cache.get(id);
      if (previous?.text === text) return previous.html;
      const html = DOMPurify.sanitize(marked.parse(text, { async: false }), {
        ALLOWED_TAGS: [
          "p",
          "br",
          "strong",
          "em",
          "del",
          "blockquote",
          "pre",
          "code",
          "ul",
          "ol",
          "li",
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
          "hr",
          "a",
          "table",
          "thead",
          "tbody",
          "tr",
          "th",
          "td",
        ],
        ALLOWED_ATTR: ["href", "title", "start"],
      });
      cache.set(id, { text, html });
      return html;
    };
  }
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import { applyConversationUpdate, type Conversation } from "../../../api/index.js";
  const renderMarkdown = createMarkdownRenderer();
  let conversation = $state.raw<typeof Conversation.Type | null>(null);
  let draft = $state("");
  let sending = $state(false);
  let connected = $state(true);
  let choosing = $state(false);
  let error = $state("");

  onMount(() =>
    window.desktop.subscribe((update) => {
      connected = update !== null;
      if (update?._tag === "Snapshot") conversation = update.conversation;
      else if (update && conversation) conversation = applyConversationUpdate(conversation, update);
    }),
  );

  async function send() {
    const submitted = draft;
    sending = true;
    error = "";
    try {
      await window.desktop.send(submitted);
      if (draft === submitted) draft = "";
    } catch {
      error = "Could not send the prompt. Check the connection and try again.";
    } finally {
      sending = false;
    }
  }

  async function chooseProject() {
    choosing = true;
    error = "";
    try {
      const selected = await window.desktop.chooseProject();
      // The subscription may already have delivered newer updates while IPC was pending.
      if (!conversation) conversation = selected;
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
  {#if conversation}
    <section aria-label="Conversation">
      <h2>New conversation</h2>
      <p>{conversation.modelName}</p>
      <p role="status">
        {!connected ? "Disconnected" : conversation.status === "idle" ? "Idle" : "Running"}
      </p>
      {#if conversation.entries.length === 0}<p>No messages yet.</p>{/if}
      {#each conversation.entries as entry (entry.id)}
        {#if entry.role === "tool"}
          <details>
            <summary
              >{entry.name} · {entry.status === "running"
                ? "Running"
                : entry.status === "failed"
                  ? "Failed"
                  : "Completed"}</summary
            >
            <pre aria-label="Input">{entry.input}</pre>
            <pre aria-label="Result">{entry.result}</pre>
          </details>
        {:else if entry.role === "assistant"}
          <div aria-label="assistant">{@html renderMarkdown(entry.id, entry.text)}</div>
        {:else}
          <p aria-label="user">{entry.text}</p>
        {/if}
      {/each}
      {#if conversation.error}<p role="alert">{conversation.error}</p>{/if}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label for="prompt">Prompt</label>
        <textarea id="prompt" bind:value={draft}></textarea>
        <button disabled={sending || !connected || conversation.status !== "idle" || !draft.trim()}
          >Send</button
        >
      </form>
    </section>
  {:else}
    <button onclick={chooseProject} disabled={choosing}>Choose project</button>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</main>
