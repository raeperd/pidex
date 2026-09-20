import type { Conversation } from "../../api/index.js";

declare global {
  interface Window {
    desktop: {
      chooseProject: () => Promise<typeof Conversation.Type | null>;
      send: (text: string) => Promise<void>;
      subscribe: (onChange: (value: typeof Conversation.Type | null) => void) => () => void;
    };
  }
}
