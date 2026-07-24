import { mount } from "svelte";
import "@fontsource-variable/dm-sans/index.css";
import "@fontsource/jetbrains-mono/400.css";

import App from "./App.svelte";
import "./styles.css";

mount(App, {
  target: document.querySelector("#app")!,
});
