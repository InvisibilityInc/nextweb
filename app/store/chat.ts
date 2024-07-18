import { trimTopic, getMessageTextContent } from "../utils";

import Locale, { getLang } from "../locales";
import { showToast } from "../components/ui-lib";
import { ModelConfig, ModelType, useAppConfig } from "./config";
import { createEmptyMask, Mask } from "./mask";
import {
  DEFAULT_INPUT_TEMPLATE,
  DEFAULT_MODELS,
  DEFAULT_SYSTEM_TEMPLATE,
  KnowledgeCutOffDate,
  ModelProvider,
  StoreKey,
  SUMMARIZE_MODEL,
  GEMINI_SUMMARIZE_MODEL,
} from "../constant";
import { ClientApi, RequestMessage, MultimodalContent } from "../client/api";
import { ChatControllerPool } from "../client/controller";
import { prettyObject } from "../utils/format";
import { estimateTokenLength } from "../utils/token";
import { nanoid } from "nanoid";
import { createPersistStore } from "../utils/store";
import { identifyDefaultClaudeModel } from "../utils/checkers";
import { collectModelsWithDefaultModel } from "../utils/model";
import { useAccessStore } from "./access";
import Cookies from "js-cookie";

export type ChatMessage = RequestMessage & {
  date: string;
  streaming?: boolean;
  isError?: boolean;
  id: string;
  model?: ModelType;
};

export function createMessage(override: Partial<ChatMessage>): ChatMessage {
  return {
    id: nanoid(),
    date: new Date().toLocaleString(),
    role: "user",
    content: "",
    ...override,
  };
}

export interface ChatStat {
  tokenCount: number;
  wordCount: number;
  charCount: number;
}

export interface ChatSession {
  id: string;
  topic: string;

  memoryPrompt: string;
  messages: ChatMessage[];
  stat: ChatStat;
  lastUpdate: number;
  lastSummarizeIndex: number;
  clearContextIndex?: number;
  chat_id: string;
  mask: Mask;
  topicUpdated: Boolean;
}
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
interface Chat {
  created_at: string;
  deleted_at: string | null;
  id: string;
  name: string;
  parent_message_id: string | null;
  updated_at: string;
  user_id: string;
}

interface ChatWithoutId {
  created_at: string;
  deleted_at: string | null;
  name: string;
  parent_message_id: string | null;
  updated_at: string;
  user_id: string;
}
export const DEFAULT_TOPIC = Locale.Store.DefaultTopic;
export const BOT_HELLO: ChatMessage = createMessage({
  role: "assistant",
  content: Locale.Store.BotHello,
});

export const options: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hour12: true,
};
function organizeChatMessages(messages: Message[]): OrganizedData {
  const organizedData: OrganizedData = {};

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

function reorganizeChatsToObject(chats: Chat[]): Record<string, ChatWithoutId> {
  return chats.reduce((acc: Record<string, ChatWithoutId>, chat: Chat) => {
    const { id, ...rest } = chat;
    acc[id] = rest;
    return acc;
  }, {});
}
function createEmptySession(): ChatSession {
  return {
    id: nanoid(),
    topic: DEFAULT_TOPIC,
    memoryPrompt: "",
    messages: [],
    stat: {
      tokenCount: 0,
      wordCount: 0,
      charCount: 0,
    },
    lastUpdate: Date.now(),
    lastSummarizeIndex: 0,
    chat_id: crypto.randomUUID(),
    mask: createEmptyMask(),
    topicUpdated: false,
  };
}

function getSummarizeModel(currentModel: string) {
  // if it is using gpt-* models, force to use 3.5 to summarize
  if (currentModel.startsWith("gpt")) {
    const configStore = useAppConfig.getState();
    const accessStore = useAccessStore.getState();
    const allModel = collectModelsWithDefaultModel(
      configStore.models,
      [configStore.customModels, accessStore.customModels].join(","),
      accessStore.defaultModel,
    );
    const summarizeModel = allModel.find(
      (m) => m.name === SUMMARIZE_MODEL && m.available,
    );
    return summarizeModel?.name ?? currentModel;
  }
  if (currentModel.startsWith("gemini")) {
    return GEMINI_SUMMARIZE_MODEL;
  }
  return currentModel;
}

function countMessages(msgs: ChatMessage[]) {
  return msgs.reduce(
    (pre, cur) => pre + estimateTokenLength(getMessageTextContent(cur)),
    0,
  );
}

function fillTemplateWith(input: string, modelConfig: ModelConfig) {
  const cutoff =
    KnowledgeCutOffDate[modelConfig.model] ?? KnowledgeCutOffDate.default;
  // Find the model in the DEFAULT_MODELS array that matches the modelConfig.model
  const modelInfo = DEFAULT_MODELS.find((m) => m.name === modelConfig.model);

  var serviceProvider = "OpenAI";
  if (modelInfo) {
    // TODO: auto detect the providerName from the modelConfig.model

    // Directly use the providerName from the modelInfo
    serviceProvider = modelInfo.provider.providerName;
  }

  const vars = {
    ServiceProvider: serviceProvider,
    cutoff,
    model: modelConfig.model,
    time: new Date().toString(),
    lang: getLang(),
    input: input,
  };

  let output = modelConfig.template ?? DEFAULT_INPUT_TEMPLATE;

  // remove duplicate
  if (input.startsWith(output)) {
    output = "";
  }

  // must contains {{input}}
  const inputVar = "{{input}}";
  if (!output.includes(inputVar)) {
    output += "\n" + inputVar;
  }

  Object.entries(vars).forEach(([name, value]) => {
    const regex = new RegExp(`{{${name}}}`, "g");
    output = output.replace(regex, value.toString()); // Ensure value is a string
  });

  return output;
}

const DEFAULT_CHAT_STATE = {
  sessions: [createEmptySession()],
  currentSessionIndex: 0,
  chats: {} as Record<string, ChatWithoutId>,
};

export const useChatStore = createPersistStore(
  DEFAULT_CHAT_STATE,
  (set, _get) => {
    function get() {
      return {
        ..._get(),
        ...methods,
      };
    }

    const methods = {
      clearSessions() {
        set(() => ({
          sessions: [createEmptySession()],
          currentSessionIndex: 0,
        }));
      },
      setChats(chats: Record<string, ChatWithoutId>) {
        set({ chats });
      },
      selectSession(index: number) {
        set({
          currentSessionIndex: index,
        });
      },

      moveSession(from: number, to: number) {
        set((state) => {
          const { sessions, currentSessionIndex: oldIndex } = state;

          // move the session
          const newSessions = [...sessions];
          const session = newSessions[from];
          newSessions.splice(from, 1);
          newSessions.splice(to, 0, session);

          // modify current session id
          let newIndex = oldIndex === from ? to : oldIndex;
          if (oldIndex > from && oldIndex <= to) {
            newIndex -= 1;
          } else if (oldIndex < from && oldIndex >= to) {
            newIndex += 1;
          }

          return {
            currentSessionIndex: newIndex,
            sessions: newSessions,
          };
        });
      },

      async newSession(
        mask?: Mask,
        chat_id?: string,
        messages?: ChatMessage[],
      ) {
        const session = createEmptySession();
        const chats = get().chats;
        const authToken = Cookies.get("auth_token");
        session.messages = [];
        if (chat_id && messages && messages?.length > 2) {
          session.messages = messages;
          session.chat_id = chat_id;
          session.topic = chats[chat_id].name;
          if (session.topic === DEFAULT_TOPIC) {
            const response = await fetch(
              `https://cloak.i.inc/chats/${session.chat_id}/autorename`,
              {
                method: "PUT",
                headers: {
                  Authorization: `Bearer ${authToken}`,
                },
              },
            );
            if (!response.ok) console.log("Error while fetching autorename");
            const chat = await response.json();
            session.topic = chat.name;
          }
        }
        if (mask) {
          const config = useAppConfig.getState();
          const globalModelConfig = config.modelConfig;

          session.mask = {
            ...mask,
            modelConfig: {
              ...globalModelConfig,
              ...mask.modelConfig,
            },
          };
        }

        set((state) => ({
          currentSessionIndex: 0,
          sessions: [session].concat(state.sessions),
        }));
      },

      nextSession(delta: number) {
        const n = get().sessions.length;
        const limit = (x: number) => (x + n) % n;
        const i = get().currentSessionIndex;
        get().selectSession(limit(i + delta));
      },

      async deleteSession(index: number) {
        const deletingLastSession = get().sessions.length === 1;
        const deletedSession = get().sessions.at(index);
        const authToken = Cookies.get("auth_token");

        if (deletedSession?.chat_id) {
          await fetch(`https://cloak.i.inc/chats/${deletedSession?.chat_id}`, {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${authToken}`,
            },
          });
        }
        if (!deletedSession) return;

        const sessions = get().sessions.slice();
        sessions.splice(index, 1);

        const currentIndex = get().currentSessionIndex;
        let nextIndex = Math.min(
          currentIndex - Number(index < currentIndex),
          sessions.length - 1,
        );

        if (deletingLastSession) {
          nextIndex = 0;
          sessions.push(createEmptySession());
        }

        // for undo delete action
        const restoreState = {
          currentSessionIndex: get().currentSessionIndex,
          sessions: get().sessions.slice(),
        };

        set(() => ({
          currentSessionIndex: nextIndex,
          sessions,
        }));

        showToast(
          Locale.Home.DeleteToast,
          {
            text: Locale.Home.Revert,
            onClick() {
              set(() => restoreState);
            },
          },
          5000,
        );
      },

      currentSession() {
        let index = get().currentSessionIndex;
        const sessions = get().sessions;

        if (index < 0 || index >= sessions.length) {
          index = Math.min(sessions.length - 1, Math.max(0, index));
          set(() => ({ currentSessionIndex: index }));
        }

        const session = sessions[index];

        return session;
      },
      async sync() {
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
          get().setChats(chats);

          const chatIdSet = new Set(Object.keys(extracted));
          const updatedSet: Set<string> = new Set();
          const localSessions = get().sessions;

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

          // Create new sessions for new chat IDs
          newChatIds.forEach((chatId) => {
            const messages: ChatMessage[] = extracted[chatId];
            get().newSession(undefined, chatId, messages);
          });

          // Remove duplicate sessions by ensuring unique chat IDs
          const uniqueSessions = Array.from(
            new Map(
              localSessions.map((session) => [session.chat_id, session]),
            ).values(),
          );
          const filteredSessions = uniqueSessions.filter((session) =>
            chatIdSet.has(session.chat_id),
          );
          // Update the local state with unique sessions
          if (filteredSessions.length < 1)
            set(() => ({
              sessions: get().sessions,
            }));
          else
            set(() => ({
              sessions: filteredSessions,
            }));
        } catch (e) {
          console.log("[Sync] failed to get remote state", e);
          throw e;
        }
      },

      async onNewMessage(message: ChatMessage) {
        get().updateCurrentSession((session) => {
          session.messages = session.messages.concat();
          session.lastUpdate = Date.now();
        });
        get().updateStat(message);
        // get().summarizeSession();

        const sessions: ChatSession[] = get().sessions;
        const index: number = get().currentSessionIndex;
        const authToken = Cookies.get("auth_token");
        const currentSession: any = get().sessions.at(index);
        const chatId: string = currentSession.chat_id;
        if (
          sessions[index].messages.length > 2 &&
          currentSession.topicUpdated === false
        ) {
          const response = await fetch(
            `https://cloak.i.inc/chats/${chatId}/autorename`,
            {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${authToken}`,
              },
            },
          );
          if (!response.ok) console.log("Error while fetching autorename");
          const chat = await response.json();
          get().updateCurrentSession((session) => {
            session.topic = chat.name;
            session.topicUpdated = true;
          });
        }
      },
      async onUserInput(content: string, attachImages?: string[]) {
        const session = get().currentSession();
        const modelConfig = session.mask.modelConfig;

        const userContent = fillTemplateWith(content, modelConfig);
        console.log("[User Input] after template: ", userContent);

        let mContent: string | MultimodalContent[] = userContent;

        if (attachImages && attachImages.length > 0) {
          mContent = [
            {
              type: "text",
              text: userContent,
            },
          ];
          mContent = mContent.concat(
            attachImages.map((url) => {
              return {
                type: "image_url",
                image_url: {
                  url: url,
                },
              };
            }),
          );
        }
        let userMessage: ChatMessage = createMessage({
          role: "user",
          content: mContent,
        });

        const botMessage: ChatMessage = createMessage({
          role: "assistant",
          streaming: true,
          model: modelConfig.model,
        });

        // get recent messages
        const recentMessages = get().getMessagesWithMemory();
        const sendMessages = recentMessages.concat(userMessage);
        const messageIndex = get().currentSession().messages.length + 1;

        // save user's and bot's message
        get().updateCurrentSession((session) => {
          const savedUserMessage = {
            ...userMessage,
            content: mContent,
          };
          session.messages = session.messages.concat([
            savedUserMessage,
            botMessage,
          ]);
        });

        var api: ClientApi;
        if (modelConfig.model.startsWith("gemini")) {
          api = new ClientApi(ModelProvider.GeminiPro);
        } else if (identifyDefaultClaudeModel(modelConfig.model)) {
          api = new ClientApi(ModelProvider.Claude);
        } else {
          api = new ClientApi(ModelProvider.GPT);
        }

        // make request
        api.llm.chat({
          messages: sendMessages,
          config: { ...modelConfig, stream: true },
          onUpdate(message) {
            botMessage.streaming = true;
            if (message) {
              botMessage.content = message;
            }
            get().updateCurrentSession((session) => {
              session.messages = session.messages.concat();
            });
          },
          onFinish(message) {
            botMessage.streaming = false;
            if (message) {
              botMessage.content = message;
              get().onNewMessage(botMessage);
            }
            ChatControllerPool.remove(session.id, botMessage.id);
          },
          onError(error) {
            const isAborted = error.message.includes("aborted");
            botMessage.content +=
              "\n\n" +
              prettyObject({
                error: true,
                message: error.message,
              });
            botMessage.streaming = false;
            userMessage.isError = !isAborted;
            botMessage.isError = !isAborted;
            get().updateCurrentSession((session) => {
              session.messages = session.messages.concat();
            });
            ChatControllerPool.remove(
              session.id,
              botMessage.id ?? messageIndex,
            );

            console.error("[Chat] failed ", error);
          },
          onController(controller) {
            // collect controller for stop/retry
            ChatControllerPool.addController(
              session.id,
              botMessage.id ?? messageIndex,
              controller,
            );
          },
        });
      },

      getMemoryPrompt() {
        const session = get().currentSession();

        if (session.memoryPrompt.length) {
          return {
            role: "system",
            content: Locale.Store.Prompt.History(session.memoryPrompt),
            date: "",
          } as ChatMessage;
        }
      },

      getMessagesWithMemory() {
        const session = get().currentSession();
        const modelConfig = session.mask.modelConfig;
        const clearContextIndex = session.clearContextIndex ?? 0;
        const messages = session.messages.slice();
        const totalMessageCount = session.messages.length;

        // in-context prompts
        const contextPrompts = session.mask.context.slice();

        // system prompts, to get close to OpenAI Web ChatGPT
        const shouldInjectSystemPrompts =
          modelConfig.enableInjectSystemPrompts &&
          session.mask.modelConfig.model.startsWith("gpt-");

        var systemPrompts: ChatMessage[] = [];
        systemPrompts = shouldInjectSystemPrompts
          ? [
              createMessage({
                role: "system",
                content: fillTemplateWith("", {
                  ...modelConfig,
                  template: DEFAULT_SYSTEM_TEMPLATE,
                }),
              }),
            ]
          : [];
        if (shouldInjectSystemPrompts) {
          console.log(
            "[Global System Prompt] ",
            systemPrompts.at(0)?.content ?? "empty",
          );
        }
        const memoryPrompt = get().getMemoryPrompt();
        // long term memory
        const shouldSendLongTermMemory =
          modelConfig.sendMemory &&
          session.memoryPrompt &&
          session.memoryPrompt.length > 0 &&
          session.lastSummarizeIndex > clearContextIndex;
        const longTermMemoryPrompts =
          shouldSendLongTermMemory && memoryPrompt ? [memoryPrompt] : [];
        const longTermMemoryStartIndex = session.lastSummarizeIndex;

        // short term memory
        const shortTermMemoryStartIndex = Math.max(
          0,
          totalMessageCount - modelConfig.historyMessageCount,
        );

        // lets concat send messages, including 4 parts:
        // 0. system prompt: to get close to OpenAI Web ChatGPT
        // 1. long term memory: summarized memory messages
        // 2. pre-defined in-context prompts
        // 3. short term memory: latest n messages
        // 4. newest input message
        const memoryStartIndex = shouldSendLongTermMemory
          ? Math.min(longTermMemoryStartIndex, shortTermMemoryStartIndex)
          : shortTermMemoryStartIndex;
        // and if user has cleared history messages, we should exclude the memory too.
        const contextStartIndex = Math.max(clearContextIndex, memoryStartIndex);
        const maxTokenThreshold = modelConfig.max_tokens;

        // get recent messages as much as possible
        const reversedRecentMessages = [];
        for (
          let i = totalMessageCount - 1, tokenCount = 0;
          i >= contextStartIndex && tokenCount < maxTokenThreshold;
          i -= 1
        ) {
          const msg = messages[i];
          if (!msg || msg.isError) continue;
          tokenCount += estimateTokenLength(getMessageTextContent(msg));
          reversedRecentMessages.push(msg);
        }
        // concat all messages
        const recentMessages = [
          ...systemPrompts,
          ...longTermMemoryPrompts,
          ...contextPrompts,
          ...reversedRecentMessages.reverse(),
        ];

        return recentMessages;
      },

      updateMessage(
        sessionIndex: number,
        messageIndex: number,
        updater: (message?: ChatMessage) => void,
      ) {
        const sessions = get().sessions;
        const session = sessions.at(sessionIndex);
        const messages = session?.messages;
        updater(messages?.at(messageIndex));
        set(() => ({ sessions }));
      },

      resetSession() {
        get().updateCurrentSession((session) => {
          session.messages = [];
          session.memoryPrompt = "";
        });
      },

      summarizeSession() {
        const config = useAppConfig.getState();
        const session = get().currentSession();
        const modelConfig = session.mask.modelConfig;

        var api: ClientApi;
        if (modelConfig.model.startsWith("gemini")) {
          api = new ClientApi(ModelProvider.GeminiPro);
        } else if (identifyDefaultClaudeModel(modelConfig.model)) {
          api = new ClientApi(ModelProvider.Claude);
        } else {
          api = new ClientApi(ModelProvider.GPT);
        }

        // remove error messages if any
        const messages = session.messages;

        // should summarize topic after chating more than 50 words
        const SUMMARIZE_MIN_LEN = 50;
        if (
          config.enableAutoGenerateTitle &&
          session.topic === DEFAULT_TOPIC &&
          countMessages(messages) >= SUMMARIZE_MIN_LEN
        ) {
          const topicMessages = messages.concat(
            createMessage({
              role: "user",
              content: Locale.Store.Prompt.Topic,
            }),
          );
          api.llm.chat({
            messages: topicMessages,
            config: {
              model: getSummarizeModel(session.mask.modelConfig.model),
              stream: false,
            },
            onFinish(message) {
              get().updateCurrentSession(
                (session) =>
                  (session.topic =
                    message.length > 0 ? trimTopic(message) : DEFAULT_TOPIC),
              );
            },
          });
        }
        const summarizeIndex = Math.max(
          session.lastSummarizeIndex,
          session.clearContextIndex ?? 0,
        );
        let toBeSummarizedMsgs = messages
          .filter((msg) => !msg.isError)
          .slice(summarizeIndex);

        const historyMsgLength = countMessages(toBeSummarizedMsgs);

        if (historyMsgLength > modelConfig?.max_tokens ?? 4000) {
          const n = toBeSummarizedMsgs.length;
          toBeSummarizedMsgs = toBeSummarizedMsgs.slice(
            Math.max(0, n - modelConfig.historyMessageCount),
          );
        }
        const memoryPrompt = get().getMemoryPrompt();
        if (memoryPrompt) {
          // add memory prompt
          toBeSummarizedMsgs.unshift(memoryPrompt);
        }

        const lastSummarizeIndex = session.messages.length;

        console.log(
          "[Chat History] ",
          toBeSummarizedMsgs,
          historyMsgLength,
          modelConfig.compressMessageLengthThreshold,
        );

        if (
          historyMsgLength > modelConfig.compressMessageLengthThreshold &&
          modelConfig.sendMemory
        ) {
          /** Destruct max_tokens while summarizing
           * this param is just shit
           **/
          const { max_tokens, ...modelcfg } = modelConfig;
          api.llm.chat({
            messages: toBeSummarizedMsgs.concat(
              createMessage({
                role: "system",
                content: Locale.Store.Prompt.Summarize,
                date: "",
              }),
            ),
            config: {
              ...modelcfg,
              stream: true,
              model: getSummarizeModel(session.mask.modelConfig.model),
            },
            onUpdate(message) {
              session.memoryPrompt = message;
            },
            onFinish(message) {
              console.log("[Memory] ", message);
              get().updateCurrentSession((session) => {
                session.lastSummarizeIndex = lastSummarizeIndex;
                session.memoryPrompt = message; // Update the memory prompt for stored it in local storage
              });
            },
            onError(err) {
              console.error("[Summarize] ", err);
            },
          });
        }
      },

      updateStat(message: ChatMessage) {
        get().updateCurrentSession((session) => {
          session.stat.charCount += message.content.length;
          // TODO: should update chat count and word count
        });
      },

      updateCurrentSession(updater: (session: ChatSession) => void) {
        const sessions = get().sessions;
        const index = get().currentSessionIndex;
        updater(sessions[index]);
        set(() => ({ sessions }));
      },

      async clearAllData() {
        const sessions = get().sessions;
        const authToken = Cookies.get("auth_token");

        try {
          const deleteRequests = sessions.map((session: ChatSession) => {
            if (session.chat_id) {
              return fetch(`https://cloak.i.inc/chats/${session.chat_id}`, {
                method: "DELETE",
                headers: {
                  Authorization: `Bearer ${authToken}`,
                },
              }).then((response) => {
                if (!response.ok) {
                  throw new Error(`Failed to delete chat ${session.topic}`);
                }
              });
            }
            return Promise.resolve();
          });

          await Promise.all(deleteRequests);
          get().clearSessions();
          localStorage.clear();
          location.reload();
        } catch (e) {
          console.error("Error during clearAllData:", e);
        }
      },
    };

    return methods;
  },
  {
    name: StoreKey.Chat,
    version: 3.1,
    migrate(persistedState, version) {
      const state = persistedState as any;
      const newState = JSON.parse(
        JSON.stringify(state),
      ) as typeof DEFAULT_CHAT_STATE;

      if (version < 2) {
        newState.sessions = [];

        const oldSessions = state.sessions;
        for (const oldSession of oldSessions) {
          const newSession = createEmptySession();
          newSession.topic = oldSession.topic;
          newSession.messages = [...oldSession.messages];
          newSession.mask.modelConfig.sendMemory = true;
          newSession.mask.modelConfig.historyMessageCount = 4;
          newSession.mask.modelConfig.compressMessageLengthThreshold = 1000;
          newState.sessions.push(newSession);
        }
      }

      if (version < 3) {
        // migrate id to nanoid
        newState.sessions.forEach((s) => {
          s.id = nanoid();
          s.messages.forEach((m) => (m.id = nanoid()));
        });
      }

      // Enable `enableInjectSystemPrompts` attribute for old sessions.
      // Resolve issue of old sessions not automatically enabling.
      if (version < 3.1) {
        newState.sessions.forEach((s) => {
          if (
            // Exclude those already set by user
            !s.mask.modelConfig.hasOwnProperty("enableInjectSystemPrompts")
          ) {
            // Because users may have changed this configuration,
            // the user's current configuration is used instead of the default
            const config = useAppConfig.getState();
            s.mask.modelConfig.enableInjectSystemPrompts =
              config.modelConfig.enableInjectSystemPrompts;
          }
        });
      }

      return newState as any;
    },
  },
);
