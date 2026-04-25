import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, like } from "drizzle-orm";
import { requireUser } from "../auth.js";
import { db, now } from "../db/client.js";
import { conversations, messages } from "../db/schema.js";
import { env } from "../env.js";
import { asRecord, badRequest, notFound, stringBody } from "../http.js";

type ConversationMode = "chat" | "thinking" | "image";

function normalizeMode(value: unknown): ConversationMode {
  if (value === "thinking" || value === "image") {
    return value;
  }
  return "chat";
}

function defaultModelForMode(mode: ConversationMode) {
  if (mode === "thinking") {
    return env.DEFAULT_THINKING_MODEL;
  }
  if (mode === "image") {
    return env.DEFAULT_IMAGE_MODEL;
  }
  return env.DEFAULT_CHAT_MODEL;
}

export async function conversationRoutes(app: FastifyInstance) {
  app.get("/api/conversations", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }

    const query = asRecord(request.query);
    const search = stringBody(query.search);
    const where = search
      ? and(eq(conversations.userId, user.id), like(conversations.title, `%${search}%`))
      : eq(conversations.userId, user.id);

    return db
      .select()
      .from(conversations)
      .where(where)
      .orderBy(desc(conversations.updatedAt), desc(conversations.createdAt))
      .all();
  });

  app.post("/api/conversations", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }

    const body = asRecord(request.body);
    const mode = normalizeMode(body.mode);
    const timestamp = now();
    const conversation = {
      id: crypto.randomUUID(),
      userId: user.id,
      title: stringBody(body.title, "新会话").slice(0, 80) || "新会话",
      model: defaultModelForMode(mode),
      mode,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    db.insert(conversations).values(conversation).run();
    return conversation;
  });

  app.get("/api/conversations/:id", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }

    const { id } = request.params as { id: string };
    const conversation = db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))
      .get();

    return conversation ?? notFound(reply, "会话不存在");
  });

  app.patch("/api/conversations/:id", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }

    const { id } = request.params as { id: string };
    const existing = db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))
      .get();

    if (!existing) {
      return notFound(reply, "会话不存在");
    }

    const body = asRecord(request.body);
    const mode = body.mode ? normalizeMode(body.mode) : normalizeMode(existing.mode);
    const patch = {
      title: body.title === undefined ? existing.title : stringBody(body.title, existing.title).slice(0, 80),
      model: mode === existing.mode ? existing.model : defaultModelForMode(mode),
      mode,
      updatedAt: now()
    };

    db.update(conversations).set(patch).where(eq(conversations.id, id)).run();
    return { ...existing, ...patch };
  });

  app.delete("/api/conversations/:id", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }

    const { id } = request.params as { id: string };
    const existing = db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))
      .get();

    if (!existing) {
      return notFound(reply, "会话不存在");
    }

    db.delete(messages).where(eq(messages.conversationId, id)).run();
    db.delete(conversations).where(eq(conversations.id, id)).run();
    return { ok: true };
  });

  app.get("/api/conversations/:id/messages", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }

    const { id } = request.params as { id: string };
    const existing = db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))
      .get();

    if (!existing) {
      return notFound(reply, "会话不存在");
    }

    return db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt)).all();
  });

  app.post("/api/conversations/:id/title", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }

    const body = asRecord(request.body);
    const title = stringBody(body.title).slice(0, 80);
    if (!title) {
      return badRequest(reply, "标题不能为空");
    }

    const { id } = request.params as { id: string };
    const result = db
      .update(conversations)
      .set({ title, updatedAt: now() })
      .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))
      .run();

    if (result.changes === 0) {
      return notFound(reply, "会话不存在");
    }

    return { ok: true, title };
  });
}
