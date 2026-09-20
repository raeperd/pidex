import type { Conversation, ConversationUpdate } from "../../api/index.js";

declare global {
  interface Window {
    desktop: {
      chooseProject: () => Promise<typeof Conversation.Type | null>;
      restart: () => Promise<void>;
      onCrash: (onCrash: () => void) => () => void;
      send: (text: string, submissionId?: string) => Promise<"accepted" | "uncertain">;
      subscribe: (
        onChange: (
          value:
            | typeof ConversationUpdate.Type
            | { _tag: "ConnectionError"; message: string }
            | null,
        ) => void,
      ) => () => void;
    };
  }
}
