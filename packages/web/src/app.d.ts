import type { Conversation } from "../../api/index.js";

declare global {
  interface Window {
    desktop: { chooseProject: () => Promise<typeof Conversation.Type | null> };
  }
}
