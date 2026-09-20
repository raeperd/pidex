import type { Conversation, ConversationUpdate } from "../../api/index.js";

declare global {
  interface Window {
    desktop: {
      chooseProject: () => Promise<typeof Conversation.Type | null>;
      send: (text: string) => Promise<void>;
      subscribe: (onChange: (value: typeof ConversationUpdate.Type | null) => void) => () => void;
    };
  }
}
