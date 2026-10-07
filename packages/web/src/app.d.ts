import type {
  Conversation,
  ConversationUpdate,
  ModelList,
  SessionList,
  SessionLocator,
} from "../../api/index.js";

declare global {
  interface Window {
    desktop: {
      newSession: (projectPath: string, sessionId: string, draftId: string) => Promise<void>;
      listSessions: (projectPath: string) => Promise<typeof SessionList.Encoded>;
      listModels: (
        sessionId: string,
      ) => Promise<{ list: typeof ModelList.Encoded | null; error: string }>;
      resumeSession: (locator: typeof SessionLocator.Type) => Promise<{
        conversation: typeof Conversation.Type | null;
        error: string;
      }>;
      chooseProject: () => Promise<typeof Conversation.Type | null>;
      addProject: (sessionId: string, draftId: string) => Promise<{ error: string }>;
      recentProjects: () => Promise<{ projects: string[]; error: string }>;
      openProject: (projectPath: string) => Promise<{
        conversation: typeof Conversation.Type | null;
        error: string;
      }>;
      restart: () => Promise<string | null>;
      onCrash: (onCrash: () => void) => () => void;

      stop: (runId: string) => Promise<void>;
      send: (
        text: string,
        submissionId?: string,
        sessionId?: string,
      ) => Promise<"accepted" | "uncertain">;
      switchProject: (
        projectPath: string,
        sessionId: string,
        draftId: string,
      ) => Promise<{ error: string }>;
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
