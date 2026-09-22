import type { Conversation, ConversationUpdate } from "../../api/index.js";

declare global {
  interface Window {
    desktop: {
      chooseProject: () => Promise<typeof Conversation.Type | null>;
      restart: () => Promise<string | null>;
      onCrash: (onCrash: () => void) => () => void;

      stop: (runId: string) => Promise<void>;
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
