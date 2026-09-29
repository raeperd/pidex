import type {
  Conversation,
  ConversationUpdate,
  RecentProjects,
  SessionList,
  SessionLocator,
} from "../../api/index.js";

declare global {
  interface Window {
    desktop: {
      newSession: (projectPath: string, sessionId: string) => Promise<void>;
      listSessions: (projectPath: string) => Promise<typeof SessionList.Encoded>;
      resumeSession: (locator: typeof SessionLocator.Type) => Promise<{
        conversation: typeof Conversation.Type | null;
        error: string;
        uncertain: boolean;
      }>;
      chooseProject: () => Promise<typeof Conversation.Type | null>;
      recentProjects: () => Promise<typeof RecentProjects.Type>;
      openRecentProject: (projectPath: string) => Promise<typeof Conversation.Type>;
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
