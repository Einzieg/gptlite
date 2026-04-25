import type {
  AuthMeResponse,
  ChatMessage,
  Conversation,
  ConversationMode,
  ImageRecord,
  ModelRecord,
  User
} from "@gptlite/shared";

export async function apiFetch<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers
    }
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  me: () => apiFetch<AuthMeResponse>("/api/auth/me"),
  setup: (payload: { username: string; password: string }) =>
    apiFetch<{ user: User }>("/api/auth/setup", { method: "POST", body: JSON.stringify(payload) }),
  login: (payload: { username: string; password: string }) =>
    apiFetch<{ user: User }>("/api/auth/login", { method: "POST", body: JSON.stringify(payload) }),
  logout: () => apiFetch<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  conversations: (search = "") =>
    apiFetch<Conversation[]>(`/api/conversations${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  createConversation: (payload: { title?: string; model?: string; mode?: ConversationMode }) =>
    apiFetch<Conversation>("/api/conversations", { method: "POST", body: JSON.stringify(payload) }),
  updateConversation: (id: string, payload: Partial<Pick<Conversation, "title" | "model" | "mode">>) =>
    apiFetch<Conversation>(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteConversation: (id: string) =>
    apiFetch<{ ok: true }>(`/api/conversations/${id}`, { method: "DELETE" }),
  messages: (conversationId: string) =>
    apiFetch<ChatMessage[]>(`/api/conversations/${conversationId}/messages`),
  patchMessage: (id: string, content: string) =>
    apiFetch<ChatMessage>(`/api/messages/${id}`, { method: "PATCH", body: JSON.stringify({ content }) }),
  deleteMessage: (id: string) =>
    apiFetch<{ ok: true }>(`/api/messages/${id}`, { method: "DELETE" }),
  images: () => apiFetch<ImageRecord[]>("/api/images"),
  generateImage: (payload: {
    prompt: string;
    size: string;
    n: number;
    quality: string;
    output_format: string;
    output_compression?: number | null;
    moderation: string;
    conversationId?: string | null;
    referenceImages?: Array<{ name: string; type: string; data: string }>;
  }) =>
    apiFetch<{ images: ImageRecord[]; messages: ChatMessage[]; conversationId: string }>("/api/images/generations", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  adminUsers: () => apiFetch<User[]>("/api/admin/users"),
  createAdminUser: (payload: { username: string; password: string; role: "admin" | "user" }) =>
    apiFetch<User>("/api/admin/users", { method: "POST", body: JSON.stringify(payload) }),
  deleteAdminUser: (id: string) =>
    apiFetch<{ ok: true }>(`/api/admin/users/${id}`, { method: "DELETE" }),
  adminModels: async () => {
    const rows = await apiFetch<Array<ModelRecord & { enabled: boolean | number }>>("/api/admin/models");
    return rows.map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
  },
  createModel: (payload: { id: string; type: string; displayName: string; enabled: boolean; sort: number }) =>
    apiFetch<ModelRecord>("/api/admin/models", { method: "POST", body: JSON.stringify(payload) }),
  updateModel: (id: string, payload: Partial<ModelRecord>) =>
    apiFetch<ModelRecord>(`/api/admin/models/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteModel: (id: string) =>
    apiFetch<{ ok: true }>(`/api/admin/models/${id}`, { method: "DELETE" })
};

export type StreamEvent =
  | { event: "meta"; data: { conversationId: string; userMessageId?: string; assistantMessageId: string } }
  | { event: "delta"; data: { content: string } }
  | { event: "done"; data: { messageId: string; content: string; status: string } }
  | { event: "error"; data: { message: string } };

export async function readEventStream(response: Response, onEvent: (event: StreamEvent) => void) {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("流式响应为空");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      let event = "message";
      let data = "";
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        }
        if (line.startsWith("data:")) {
          data += line.slice(5).trim();
        }
      }
      if (data) {
        onEvent({ event, data: JSON.parse(data) } as StreamEvent);
      }
    }
  }
}
