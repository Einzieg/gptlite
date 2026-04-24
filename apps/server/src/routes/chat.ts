import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { ChatApiMessage } from "../openai.js";
import { type SafeUser, requireUser } from "../auth.js";
import { db, now } from "../db/client.js";
import { conversations, messages, type ConversationRow, type MessageRow } from "../db/schema.js";
import { env } from "../env.js";
import { asRecord, badRequest, notFound, stringBody } from "../http.js";
import { streamChatCompletion } from "../openai.js";

type ConversationMode = "chat" | "thinking" | "image";

interface StreamContext {
  request: FastifyRequest;
  reply: FastifyReply;
  conversation: ConversationRow;
  history: MessageRow[];
  model: string;
  temperature?: number;
  userMessageId?: string;
  parentId?: string | null;
}

function modeModel(mode: ConversationMode) {
  if (mode === "thinking") {
    return env.DEFAULT_THINKING_MODEL;
  }
  return env.DEFAULT_CHAT_MODEL;
}

function toApiMessages(rows: MessageRow[]): ChatApiMessage[] {
  return rows
    .filter((message) => message.role === "user" || message.role === "assistant")
    .filter((message) => message.content.trim().length > 0)
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content
    }));
}

function updateConversationTouch(conversationId: string, title?: string) {
  const patch: { updatedAt: number; title?: string } = { updatedAt: now() };
  if (title) {
    patch.title = title;
  }
  db.update(conversations).set(patch).where(eq(conversations.id, conversationId)).run();
}

function firstTitle(content: string) {
  return content.replace(/\s+/g, " ").trim().slice(0, 28) || "新会话";
}

function writeSse(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function streamAssistantReply(context: StreamContext) {
  const assistantId = crypto.randomUUID();
  const timestamp = now();
  db.insert(messages)
    .values({
      id: assistantId,
      conversationId: context.conversation.id,
      role: "assistant",
      content: "",
      model: context.model,
      status: "streaming",
      parentId: context.parentId ?? context.userMessageId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp
    })
    .run();

  context.reply.hijack();
  context.reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const abortController = new AbortController();
  let clientClosed = false;
  let finalContent = "";

  context.request.raw.on("close", () => {
    if (!context.reply.raw.writableEnded) {
      clientClosed = true;
      abortController.abort();
    }
  });

  writeSse(context.reply, "meta", {
    conversationId: context.conversation.id,
    userMessageId: context.userMessageId,
    assistantMessageId: assistantId
  });

  try {
    for await (const delta of streamChatCompletion({
      model: context.model,
      messages: toApiMessages(context.history),
      temperature: context.temperature,
      signal: abortController.signal
    })) {
      finalContent += delta;
      writeSse(context.reply, "delta", { content: delta });
    }

    db.update(messages)
      .set({ content: finalContent, status: "done", updatedAt: now() })
      .where(eq(messages.id, assistantId))
      .run();
    updateConversationTouch(context.conversation.id);
    writeSse(context.reply, "done", { messageId: assistantId, content: finalContent, status: "done" });
  } catch (error) {
    const status = clientClosed || abortController.signal.aborted ? "stopped" : "error";
    db.update(messages)
      .set({ content: finalContent, status, updatedAt: now() })
      .where(eq(messages.id, assistantId))
      .run();
    updateConversationTouch(context.conversation.id);

    if (!clientClosed) {
      const message = error instanceof Error ? error.message : "生成失败";
      writeSse(context.reply, "error", { message });
    }
  } finally {
    if (!context.reply.raw.writableEnded) {
      context.reply.raw.end();
    }
  }
}

function getOwnedConversation(id: string, userId: string) {
  return db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
    .get();
}

function orderedMessages(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .all();
}

function ensureMode(value: unknown): ConversationMode {
  if (value === "thinking") {
    return "thinking";
  }
  return "chat";
}

export async function chatRoutes(app: FastifyInstance) {
  app.post("/api/chat/stream", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }

    const body = asRecord(request.body);
    const conversationId = stringBody(body.conversationId);
    const content = stringBody(body.message);
    if (!conversationId || !content) {
      return badRequest(reply, "conversationId 和 message 必填");
    }

    const conversation = getOwnedConversation(conversationId, user.id);
    if (!conversation) {
      return notFound(reply, "会话不存在");
    }

    const mode = ensureMode(body.mode ?? conversation.mode);
    const model = modeModel(mode);
    const timestamp = now();
    const userMessageId = crypto.randomUUID();

    db.insert(messages)
      .values({
        id: userMessageId,
        conversationId,
        role: "user",
        content,
        model: null,
        status: "done",
        parentId: null,
        createdAt: timestamp,
        updatedAt: timestamp
      })
      .run();

    const shouldTitle = conversation.title === "新会话";
    updateConversationTouch(conversationId, shouldTitle ? firstTitle(content) : undefined);
    const history = orderedMessages(conversationId);

    await streamAssistantReply({
      request,
      reply,
      conversation,
      history,
      model,
      temperature: typeof body.temperature === "number" ? body.temperature : undefined,
      userMessageId,
      parentId: userMessageId
    });
  });

  app.patch("/api/messages/:id", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }

    const { id } = request.params as { id: string };
    const body = asRecord(request.body);
    const content = stringBody(body.content);
    if (!content) {
      return badRequest(reply, "消息内容不能为空");
    }

    const existing = getOwnedMessage(id, user);
    if (!existing) {
      return notFound(reply, "消息不存在");
    }

    db.update(messages).set({ content, updatedAt: now() }).where(eq(messages.id, id)).run();
    updateConversationTouch(existing.conversation.id);
    return { ...existing.message, content };
  });

  app.delete("/api/messages/:id", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }

    const { id } = request.params as { id: string };
    const existing = getOwnedMessage(id, user);
    if (!existing) {
      return notFound(reply, "消息不存在");
    }

    db.delete(messages).where(eq(messages.id, id)).run();
    updateConversationTouch(existing.conversation.id);
    return { ok: true };
  });

  app.post("/api/messages/:id/regenerate", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }

    const { id } = request.params as { id: string };
    const target = getOwnedMessage(id, user);
    if (!target) {
      return notFound(reply, "消息不存在");
    }

    const all = orderedMessages(target.conversation.id);
    const targetIndex = all.findIndex((message) => message.id === id);
    if (targetIndex < 0) {
      return notFound(reply, "消息不存在");
    }

    let promptIndex = targetIndex;
    if (target.message.role === "assistant") {
      promptIndex = all
        .slice(0, targetIndex)
        .map((message, index) => ({ message, index }))
        .reverse()
        .find((item) => item.message.role === "user")?.index ?? -1;
    }

    if (promptIndex < 0 || all[promptIndex]?.role !== "user") {
      return badRequest(reply, "没有可重新生成的用户消息");
    }

    const deleteFrom = target.message.role === "assistant" ? targetIndex : promptIndex + 1;
    const deleteIds = all.slice(deleteFrom).map((message) => message.id);
    if (deleteIds.length > 0) {
      db.delete(messages).where(inArray(messages.id, deleteIds)).run();
    }

    const history = all.slice(0, promptIndex + 1);
    const body = asRecord(request.body);
    const mode = ensureMode(body.mode ?? target.conversation.mode);
    const model = modeModel(mode);
    await streamAssistantReply({
      request,
      reply,
      conversation: target.conversation,
      history,
      model,
      temperature: typeof body.temperature === "number" ? body.temperature : undefined,
      parentId: all[promptIndex].id
    });
  });
}

function getOwnedMessage(id: string, user: SafeUser) {
  const message = db.select().from(messages).where(eq(messages.id, id)).get();
  if (!message) {
    return null;
  }

  const conversation = getOwnedConversation(message.conversationId, user.id);
  if (!conversation) {
    return null;
  }

  return { message, conversation };
}
