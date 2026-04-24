import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { requireUser } from "../auth.js";
import { db, now } from "../db/client.js";
import { conversations, images, messages, type MessageRow } from "../db/schema.js";
import { env } from "../env.js";
import { asRecord, badRequest, notFound, stringBody } from "../http.js";
import { generateImage } from "../openai.js";

const MAX_REFERENCE_IMAGES = 4;
const MAX_REFERENCE_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_CONTEXT_MESSAGE_LIMIT = 6;
const IMAGE_CONTEXT_MESSAGE_CHARS = 700;
const IMAGE_CONTEXT_TOTAL_CHARS = 3200;
const IMAGE_MESSAGE_PREFIX = "__gptlite_image__:";

export async function imageRoutes(app: FastifyInstance) {
  app.post("/api/images/generations", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }

    const body = asRecord(request.body);
    const prompt = stringBody(body.prompt);
    if (!prompt) {
      return badRequest(reply, "图片提示词不能为空");
    }

    const model = env.DEFAULT_IMAGE_MODEL;
    const size = stringBody(body.size, "1024x1024");
    const n = Math.min(Math.max(Number(body.n ?? 1), 1), 4);
    const timestamp = now();
    const conversation = ensureImageConversation({
      conversationId: typeof body.conversationId === "string" ? body.conversationId : "",
      userId: user.id,
      prompt,
      timestamp
    });

    if (!conversation) {
      return notFound(reply, "会话不存在");
    }

    let referenceImages;
    try {
      referenceImages = normalizeReferenceImages(body.referenceImages);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : "参考图无效");
    }

    const imagePrompt = buildImagePrompt({
      prompt,
      history: recentImageContext(conversation.id)
    });
    const userMessage = {
      id: crypto.randomUUID(),
      conversationId: conversation.id,
      role: "user",
      content: prompt,
      model: null,
      status: "done",
      parentId: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    db.insert(messages).values(userMessage).run();

    const results = await generateImage({ model, prompt: imagePrompt, size, n, referenceImages });
    const records = results.map((result) => ({
      id: crypto.randomUUID(),
      userId: user.id,
      conversationId: conversation.id,
      prompt,
      model,
      url: result.url,
      base64: result.base64,
      status: "done",
      createdAt: timestamp
    }));

    if (records.length > 0) {
      db.insert(images).values(records).run();
    }

    const assistantMessage = {
      id: crypto.randomUUID(),
      conversationId: conversation.id,
      role: "assistant",
      content: encodeImageMessage({
        prompt,
        images: records.map((record) => ({
          id: record.id,
          url: record.url,
          base64: record.base64
        }))
      }),
      model,
      status: "done",
      parentId: userMessage.id,
      createdAt: now(),
      updatedAt: now()
    };
    db.insert(messages).values(assistantMessage).run();
    touchConversation(conversation.id, prompt, timestamp);

    return { images: records, messages: [userMessage, assistantMessage], conversationId: conversation.id };
  });

  app.get("/api/images", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }

    return db.select().from(images).where(eq(images.userId, user.id)).orderBy(desc(images.createdAt)).all();
  });

  app.get("/api/images/:id", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }

    const { id } = request.params as { id: string };
    const image = db.select().from(images).where(and(eq(images.id, id), eq(images.userId, user.id))).get();
    return image ?? notFound(reply, "图片不存在");
  });

  app.delete("/api/images/:id", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) {
      return;
    }

    const { id } = request.params as { id: string };
    const result = db.delete(images).where(and(eq(images.id, id), eq(images.userId, user.id))).run();
    if (result.changes === 0) {
      return notFound(reply, "图片不存在");
    }

    return { ok: true };
  });
}

function ensureImageConversation(params: {
  conversationId: string;
  userId: string;
  prompt: string;
  timestamp: number;
}) {
  if (params.conversationId) {
    const conversation = db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, params.conversationId), eq(conversations.userId, params.userId)))
      .get();

    if (!conversation) {
      return null;
    }

    db.update(conversations)
      .set({ mode: "image", model: env.DEFAULT_IMAGE_MODEL, updatedAt: params.timestamp })
      .where(eq(conversations.id, conversation.id))
      .run();
    return { ...conversation, mode: "image", model: env.DEFAULT_IMAGE_MODEL };
  }

  const conversation = {
    id: crypto.randomUUID(),
    userId: params.userId,
    title: firstTitle(params.prompt),
    model: env.DEFAULT_IMAGE_MODEL,
    mode: "image",
    createdAt: params.timestamp,
    updatedAt: params.timestamp
  };
  db.insert(conversations).values(conversation).run();
  return conversation;
}

function touchConversation(conversationId: string, prompt: string, timestamp: number) {
  const conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  const patch: { updatedAt: number; mode: string; model: string; title?: string } = {
    updatedAt: timestamp,
    mode: "image",
    model: env.DEFAULT_IMAGE_MODEL
  };
  if (conversation?.title === "新会话") {
    patch.title = firstTitle(prompt);
  }
  db.update(conversations).set(patch).where(eq(conversations.id, conversationId)).run();
}

function firstTitle(content: string) {
  return content.replace(/\s+/g, " ").trim().slice(0, 28) || "新会话";
}

function encodeImageMessage(payload: {
  prompt: string;
  images: Array<{ id: string; url: string | null; base64: string | null }>;
}) {
  return `${IMAGE_MESSAGE_PREFIX}${JSON.stringify({ type: "image_result", ...payload })}`;
}

function recentImageContext(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(IMAGE_CONTEXT_MESSAGE_LIMIT)
    .all()
    .reverse()
    .map(formatContextMessage)
    .filter(Boolean)
    .join("\n")
    .slice(0, IMAGE_CONTEXT_TOTAL_CHARS);
}

function buildImagePrompt(params: { prompt: string; history: string }) {
  if (!params.history) {
    return params.prompt;
  }

  return [
    "Use the recent conversation context below to keep visual continuity and resolve pronouns or follow-up edits.",
    "Do not add text, labels, watermarks, or UI copy unless the latest request explicitly asks for it.",
    "",
    "Recent context:",
    params.history,
    "",
    "Latest image request:",
    params.prompt
  ].join("\n");
}

function formatContextMessage(message: MessageRow) {
  const content = message.content.trim();
  if (!content) {
    return "";
  }

  const imagePrompt = parseImagePrompt(content);
  if (imagePrompt) {
    return truncateContext(`Assistant generated an image for: ${imagePrompt}`);
  }

  if (content.startsWith(IMAGE_MESSAGE_PREFIX)) {
    return "";
  }

  const role = message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : "System";
  return truncateContext(`${role}: ${content.replace(/\s+/g, " ")}`);
}

function parseImagePrompt(content: string) {
  if (!content.startsWith(IMAGE_MESSAGE_PREFIX)) {
    return "";
  }

  try {
    const payload = JSON.parse(content.slice(IMAGE_MESSAGE_PREFIX.length)) as { prompt?: unknown };
    return typeof payload.prompt === "string" ? payload.prompt.replace(/\s+/g, " ").trim() : "";
  } catch {
    return "";
  }
}

function truncateContext(value: string) {
  return value.length > IMAGE_CONTEXT_MESSAGE_CHARS
    ? `${value.slice(0, IMAGE_CONTEXT_MESSAGE_CHARS - 1)}…`
    : value;
}

function normalizeReferenceImages(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, MAX_REFERENCE_IMAGES).map((item) => {
    const record = asRecord(item);
    const name = stringBody(record.name, "reference.png").slice(0, 120);
    const type = stringBody(record.type, "image/png");
    const data = typeof record.data === "string" ? record.data : "";
    const base64 = data.includes(",") ? data.split(",").pop() ?? "" : data;
    const approxBytes = Math.floor((base64.length * 3) / 4);

    if (!type.startsWith("image/") || !data || approxBytes > MAX_REFERENCE_IMAGE_BYTES) {
      throw new Error("参考图必须是 12MB 以内的图片");
    }

    return { name, type, data };
  });
}
