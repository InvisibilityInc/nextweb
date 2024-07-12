import { getClientConfig } from "../config/client";
import { Updater } from "../typing";
import { ApiPath, STORAGE_KEY, StoreKey } from "../constant";
import { createPersistStore } from "../utils/store";
import {
  AppState,
  getLocalAppState,
  GetStoreState,
  mergeAppState,
  setLocalAppState,
} from "../utils/sync";
import { downloadAs, readFromFile } from "../utils";
import { showToast } from "../components/ui-lib";
import Locale from "../locales";
import { createSyncClient, ProviderType } from "../utils/cloud";
import { corsPath } from "../utils/cors";
import Cookies from "js-cookie";
import { ChatMessage, useChatStore } from "./chat";

export interface WebDavConfig {
  server: string;
  username: string;
  password: string;
}

const isApp = !!getClientConfig()?.isApp;
export type SyncStore = GetStoreState<typeof useSyncStore>;

const DEFAULT_SYNC_STATE = {
  provider: ProviderType.WebDAV,
  useProxy: true,
  proxyUrl: corsPath(ApiPath.Cors),

  webdav: {
    endpoint: "",
    username: "",
    password: "",
  },

  upstash: {
    endpoint: "",
    username: STORAGE_KEY,
    apiKey: "",
  },

  lastSyncTime: 0,
  lastProvider: "",
};

interface Message {
  chat_id: string;
  created_at: string;
  id: string;
  model_id: string;
  regenerated: boolean;
  role: string;
  text: string;
  updated_at: string;
  user_id: string;
}
interface OrganizedData {
  [chatId: string]: any[];
}
// function organizeChatMessages(messages: Message[]): OrganizedData {
//   const organizedData: OrganizedData = {};
//   const options: Intl.DateTimeFormatOptions = {
//     year: "numeric",
//     month: "numeric",
//     day: "numeric",
//     hour: "numeric",
//     minute: "numeric",
//     second: "numeric",
//     hour12: true,
//   };

//   // Organize messages by chat ID
//   for (const message of messages) {
//     const chatId = message.chat_id;
//     if (!organizedData[chatId]) {
//       organizedData[chatId] = [];
//     }
//     organizedData[chatId].push({
//       id: message.id,
//       role: message.role,
//       content: message.text,
//       date: message.created_at,
//     });
//   }

//   for (const chatId in organizedData) {
//     organizedData[chatId].sort((a, b) => {
//       return new Date(a.date).getTime() - new Date(b.date).getTime();
//     });

//     organizedData[chatId].forEach((message) => {
//       message.date = new Intl.DateTimeFormat("en-US", options).format(
//         new Date(message.date),
//       );
//     });
//   }
//   return organizedData;
// }
function organizeChatMessages(messages: Message[]): OrganizedData {
  const organizedData: OrganizedData = {};
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: true,
  };

  // Organize messages by chat ID
  for (const message of messages) {
    const chatId = message.chat_id;
    if (!organizedData[chatId]) {
      organizedData[chatId] = [];
    }
    organizedData[chatId].push({
      id: message.id,
      role: message.role,
      content: message.text,
      date: message.created_at,
    });
  }

  for (const chatId in organizedData) {
    const userMessages = organizedData[chatId].filter(
      (message) => message.role === "user",
    );
    const assistantMessages = organizedData[chatId].filter(
      (message) => message.role !== "user",
    );

    userMessages.sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );
    assistantMessages.sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    const combinedMessages = [];
    let assistantIndex = 0;

    for (const userMessage of userMessages) {
      combinedMessages.push(userMessage);
      // Find the closest assistant message
      while (
        assistantIndex < assistantMessages.length &&
        new Date(assistantMessages[assistantIndex].date).getTime() <
          new Date(userMessage.date).getTime()
      ) {
        assistantIndex++;
      }
      if (assistantIndex < assistantMessages.length) {
        combinedMessages.push(assistantMessages[assistantIndex]);
        assistantIndex++;
      }
    }

    // Add any remaining assistant messages
    while (assistantIndex < assistantMessages.length) {
      combinedMessages.push(assistantMessages[assistantIndex]);
      assistantIndex++;
    }

    // Format dates
    combinedMessages.forEach((message) => {
      message.date = new Intl.DateTimeFormat("en-US", options).format(
        new Date(message.date),
      );
    });

    organizedData[chatId] = combinedMessages;
  }

  return organizedData;
}

interface Chat {
  created_at: string;
  deleted_at: string | null;
  id: string;
  name: string;
  parent_message_id: string | null;
  updated_at: string;
  user_id: string;
}

export interface ChatWithoutId {
  created_at: string;
  deleted_at: string | null;
  name: string;
  parent_message_id: string | null;
  updated_at: string;
  user_id: string;
}

function reorganizeChatsToObject(chats: Chat[]): Record<string, ChatWithoutId> {
  return chats.reduce((acc: Record<string, ChatWithoutId>, chat: Chat) => {
    const { id, ...rest } = chat;
    acc[id] = rest;
    return acc;
  }, {});
}

export const useSyncStore = createPersistStore(
  DEFAULT_SYNC_STATE,
  (set, get) => ({
    cloudSync() {
      const config = get()[get().provider];
      return Object.values(config).every((c) => c.toString().length > 0);
    },

    markSyncTime() {
      set({ lastSyncTime: Date.now(), lastProvider: get().provider });
    },

    export() {
      const state = getLocalAppState();
      const datePart = isApp
        ? `${new Date().toLocaleDateString().replace(/\//g, "_")} ${new Date()
            .toLocaleTimeString()
            .replace(/:/g, "_")}`
        : new Date().toLocaleString();

      const fileName = `Backup-${datePart}.json`;
      downloadAs(JSON.stringify(state), fileName);
    },

    async import() {
      const rawContent = await readFromFile();

      try {
        const remoteState = JSON.parse(rawContent) as AppState;
        const localState = getLocalAppState();
        mergeAppState(localState, remoteState);
        setLocalAppState(localState);
        location.reload();
      } catch (e) {
        console.error("[Import]", e);
        showToast(Locale.Settings.Sync.ImportFailed);
      }
    },

    getClient() {
      const provider = get().provider;
      const client = createSyncClient(provider, get());
      return client;
    },

    async sync() {
      const localState = getLocalAppState();
      const authToken = Cookies.get("auth_token");

      try {
        const response = await fetch("https://cloak.i.inc/sync/all", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        });
        if (!response.ok) {
          throw new Error("Failed to sync messages");
        }
        const fetchedMessages = await response.json();
        const extracted = organizeChatMessages(fetchedMessages.messages);
        const chats = reorganizeChatsToObject(fetchedMessages.chats);
        useChatStore.getState().setChats(chats);

        const chatIdSet = new Set(Object.keys(extracted));
        const updatedSet: Set<string> = new Set();
        // const localSessions = localState["chat-next-web-store"].sessions;
        const localSessions = useChatStore.getState().sessions;
        // Update existing sessions
        localSessions.forEach((session) => {
          const currChatId = session["chat_id"];
          if (chatIdSet.has(currChatId)) {
            updatedSet.add(currChatId);
            session.messages = extracted[currChatId];
          }
        });

        // Identify new chat IDs
        const newChatIds = Array.from(chatIdSet).filter(
          (chatId) => !updatedSet.has(chatId),
        );

        // Log new chat IDs for debugging
        console.log("New chat IDs:", newChatIds);

        // Create new sessions for new chat IDs
        newChatIds.forEach((chatId) => {
          const messages: ChatMessage[] = extracted[chatId];
          console.log(
            "Creating new session for chatId:",
            chatId,
            "with messages:",
            messages,
          );
          useChatStore.getState().newSession(undefined, chatId, messages);
        });

        // Remove duplicate sessions by ensuring unique chat IDs
        const uniqueSessions = Array.from(
          new Map(
            localSessions.map((session) => [session.chat_id, session]),
          ).values(),
        );
        uniqueSessions.filter((session) => chatIdSet.has(session.chat_id));

        // Update the local state with unique sessions
        useChatStore.getState().sessions = uniqueSessions;
        localState["chat-next-web-store"].sessions = uniqueSessions;

        console.log(
          "Final sessions:",
          localState["chat-next-web-store"].sessions,
        );
      } catch (e) {
        console.log("[Sync] failed to get remote state", e);
        throw e;
      }

      // this.markSyncTime();
    },

    async check() {
      const client = this.getClient();
      return await client.check();
    },
  }),
  {
    name: StoreKey.Sync,
    version: 1.2,

    migrate(persistedState, version) {
      const newState = persistedState as typeof DEFAULT_SYNC_STATE;

      if (version < 1.1) {
        newState.upstash.username = STORAGE_KEY;
      }

      if (version < 1.2) {
        if (
          (persistedState as typeof DEFAULT_SYNC_STATE).proxyUrl ===
          "/api/cors/"
        ) {
          newState.proxyUrl = "";
        }
      }

      return newState as any;
    },
  },
);
