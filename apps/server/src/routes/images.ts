import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
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
const IMAGE_QUALITIES = new Set(["auto", "low", "medium", "high"]);
const IMAGE_FORMATS = new Set(["png", "jpeg", "webp"]);
const IMAGE_MODERATIONS = new Set(["auto", "low"]);

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
    const size = normalizeImageSize(stringBody(body.size, "auto"));
    const n = Math.min(Math.max(Number(body.n ?? 1), 1), 4);
    const quality = oneOf(body.quality, IMAGE_QUALITIES, "auto");
    const outputFormat = oneOf(body.output_format, IMAGE_FORMATS, "png");
    const moderation = oneOf(body.moderation, IMAGE_MODERATIONS, "auto");
    const outputCompression = normalizeOutputCompression(body.output_compression, outputFormat);
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
      referenceImages = await materializeReferenceImages(referenceImages, request);
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

    const results = await generateImage({
      model,
      prompt: imagePrompt,
      size,
      n,
      quality,
      outputFormat,
      outputCompression,
      moderation,
      referenceImages
    });
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
        outputFormat,
        images: records.map((record) => ({
          id: record.id,
          url: record.url,
          base64: record.base64,
          mimeType: mimeTypeForFormat(outputFormat),
          extension: outputFormat
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
  outputFormat?: string;
  images: Array<{
    id: string;
    url: string | null;
    base64: string | null;
    mimeType?: string;
    extension?: string;
  }>;
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

function oneOf(value: unknown, allowed: Set<string>, fallback: string) {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function normalizeImageSize(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "auto";
  }
  const match = trimmed.match(/^(\d+)\s*[xX×]\s*(\d+)$/);
  if (!match) {
    return trimmed;
  }
  const width = roundToMultiple(Number(match[1]), 16);
  const height = roundToMultiple(Number(match[2]), 16);
  return `${width}x${height}`;
}

function roundToMultiple(value: number, multiple: number) {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function normalizeOutputCompression(value: unknown, outputFormat: string) {
  if (outputFormat === "png") {
    return undefined;
  }

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return undefined;
  }
  return Math.min(Math.max(Math.round(numberValue), 0), 100);
}

function mimeTypeForFormat(format: string) {
  if (format === "jpeg") {
    return "image/jpeg";
  }
  if (format === "webp") {
    return "image/webp";
  }
  return "image/png";
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
    const url = typeof record.url === "string" ? record.url.trim() : "";
    const base64 = data.includes(",") ? data.split(",").pop() ?? "" : data;
    const approxBytes = Math.floor((base64.length * 3) / 4);

    if (url) {
      return { name, type, data, url };
    }

    if (!type.startsWith("image/") || !data || approxBytes > MAX_REFERENCE_IMAGE_BYTES) {
      throw new Error("参考图必须是 12MB 以内的图片");
    }

    return { name, type, data };
  });
}

async function materializeReferenceImages(
  referenceImages: ReturnType<typeof normalizeReferenceImages>,
  request: FastifyRequest
) {
  if (env.IMAGE_API_PROVIDER !== "grsai" || referenceImages.length === 0) {
    return referenceImages;
  }

  const baseUrl = publicBaseUrl(request);
  if (!baseUrl) {
    throw new Error("GRSAI 参考图需要配置 PUBLIC_APP_URL 或正确透传 Host");
  }

  await mkdir(env.REFERENCE_IMAGE_DIR, { recursive: true });

  return Promise.all(
    referenceImages.map(async (image) => {
      if (image.url) {
        return image;
      }

      const match = image.data.match(/^data:([^;]+);base64,(.+)$/);
      const mimeType = match?.[1] || image.type || "image/png";
      const base64 = match?.[2] || image.data;
      const extension = extensionForMime(mimeType);
      const filename = `${crypto.randomUUID()}.${extension}`;
      await writeFile(join(env.REFERENCE_IMAGE_DIR, filename), Buffer.from(base64, "base64"));

      return {
        ...image,
        url: `${baseUrl}${publicReferencePath()}${encodeURIComponent(filename)}`
      };
    })
  );
}

function publicBaseUrl(request: FastifyRequest) {
  if (env.PUBLIC_APP_URL) {
    return env.PUBLIC_APP_URL;
  }

  const forwardedProto = firstHeader(request.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeader(request.headers["x-forwarded-host"]);
  const host = forwardedHost || firstHeader(request.headers.host);
  if (!host) {
    return "";
  }

  return `${(forwardedProto || "http").split(",")[0].trim()}://${host.split(",")[0].trim()}`;
}

function publicReferencePath() {
  const prefix = env.REFERENCE_IMAGE_PUBLIC_PATH.startsWith("/")
    ? env.REFERENCE_IMAGE_PUBLIC_PATH
    : `/${env.REFERENCE_IMAGE_PUBLIC_PATH}`;
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

function firstHeader(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function extensionForMime(mimeType: string) {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) {
    return "jpg";
  }
  if (mimeType.includes("webp")) {
    return "webp";
  }
  return "png";
}
