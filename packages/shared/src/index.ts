export type UserRole = "admin" | "user";
export type ConversationMode = "chat" | "thinking" | "image";
export type MessageRole = "system" | "user" | "assistant";
export type MessageStatus = "pending" | "streaming" | "done" | "error" | "stopped";
export type ModelType = "chat" | "image" | "reasoning";

export interface User {
  id: string;
  username: string;
  role: UserRole;
  createdAt: number;
  updatedAt: number;
}

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  model: string;
  mode: ConversationMode;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  model: string | null;
  status: MessageStatus;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ImageRecord {
  id: string;
  userId: string;
  conversationId: string | null;
  prompt: string;
  model: string;
  url: string | null;
  base64: string | null;
  status: MessageStatus;
  createdAt: number;
}

export interface ModelRecord {
  id: string;
  type: ModelType;
  displayName: string;
  enabled: boolean;
  sort: number;
  createdAt: number;
  updatedAt: number;
}

export interface AuthMeResponse {
  user: User | null;
  setupRequired: boolean;
}

export interface StreamMetaEvent {
  conversationId: string;
  userMessageId?: string;
  assistantMessageId: string;
}

export interface StreamDeltaEvent {
  content: string;
}

export interface StreamDoneEvent {
  messageId: string;
  content: string;
  status: MessageStatus;
}

export interface StreamErrorEvent {
  message: string;
}
