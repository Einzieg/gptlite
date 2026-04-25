import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { env, databasePathFromUrl } from "../env.js";
import * as schema from "./schema.js";

const IMAGE_MESSAGE_PREFIX = "__gptlite_image__:";

const rawPath = databasePathFromUrl(env.DATABASE_URL);
const databasePath = rawPath.startsWith("/") ? rawPath : resolve(process.cwd(), rawPath);

mkdirSync(dirname(databasePath), { recursive: true });

export const sqlite = new Database(databasePath);
export const db = drizzle(sqlite, { schema });

export function now() {
  return Math.floor(Date.now() / 1000);
}

export function hasUsers() {
  return sqlite.prepare("SELECT 1 FROM users LIMIT 1").get() !== undefined;
}

export async function initializeDatabase() {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '新会话',
      model TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'chat',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT,
      status TEXT NOT NULL DEFAULT 'done',
      parent_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT,
      prompt TEXT NOT NULL,
      model TEXT NOT NULL,
      url TEXT,
      base64 TEXT,
      status TEXT NOT NULL DEFAULT 'done',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      display_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_images_user_created ON images(user_id, created_at DESC);
  `);

  synchronizeConfiguredModels();
  repairConversationTimestamps();
  seedModels();
  backfillImageMessages();
  await seedAdminFromEnv();
}

function synchronizeConfiguredModels() {
  sqlite.prepare("DELETE FROM models WHERE id LIKE 'gpt-4%'").run();
  sqlite
    .prepare("UPDATE conversations SET model = @model WHERE mode = 'thinking' AND model != @model")
    .run({ model: env.DEFAULT_THINKING_MODEL });
  sqlite
    .prepare("UPDATE conversations SET model = @model WHERE mode = 'image' AND model != @model")
    .run({ model: env.DEFAULT_IMAGE_MODEL });
  sqlite
    .prepare("UPDATE conversations SET model = @model WHERE mode NOT IN ('thinking', 'image') AND model != @model")
    .run({ model: env.DEFAULT_CHAT_MODEL });
}

function repairConversationTimestamps() {
  const key = "conversation_timestamp_repair_v1";
  const repaired = sqlite.prepare("SELECT 1 FROM settings WHERE key = ?").get(key);
  if (repaired) {
    return;
  }

  sqlite.exec(`
    UPDATE conversations
    SET updated_at = max(
      created_at,
      coalesce((SELECT max(updated_at) FROM messages WHERE messages.conversation_id = conversations.id), 0),
      coalesce((SELECT max(created_at) FROM images WHERE images.conversation_id = conversations.id), 0)
    )
  `);
  sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, String(now()));
}

function seedModels() {
  const timestamp = now();
  const insert = sqlite.prepare(`
    INSERT OR IGNORE INTO models (id, type, display_name, enabled, sort, created_at, updated_at)
    VALUES (@id, @type, @displayName, 1, @sort, @createdAt, @updatedAt)
  `);

  insert.run({
    id: env.DEFAULT_CHAT_MODEL,
    type: "chat",
    displayName: env.DEFAULT_CHAT_MODEL,
    sort: 10,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  insert.run({
    id: env.DEFAULT_THINKING_MODEL,
    type: "reasoning",
    displayName: env.DEFAULT_THINKING_MODEL,
    sort: 15,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  insert.run({
    id: env.DEFAULT_IMAGE_MODEL,
    type: "image",
    displayName: env.DEFAULT_IMAGE_MODEL === "gpt-image-2" ? "GPT Image 2" : env.DEFAULT_IMAGE_MODEL,
    sort: 20,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function backfillImageMessages() {
  const imageRows = sqlite
    .prepare<
      [],
      {
        id: string;
        user_id: string;
        conversation_id: string | null;
        prompt: string;
        model: string;
        url: string | null;
        base64: string | null;
        created_at: number;
      }
    >(
      `
        SELECT id, user_id, conversation_id, prompt, model, url, base64, created_at
        FROM images AS image
        WHERE NOT EXISTS (
          SELECT 1
          FROM messages AS message
          WHERE message.content LIKE '${IMAGE_MESSAGE_PREFIX}%'
            AND message.content LIKE '%' || image.id || '%'
        )
        ORDER BY created_at ASC
      `
    )
    .all();

  if (imageRows.length === 0) {
    return;
  }

  const groups = new Map<string, typeof imageRows>();
  for (const image of imageRows) {
    const key = [image.user_id, image.conversation_id ?? "", image.prompt, image.created_at].join("\u001f");
    groups.set(key, [...(groups.get(key) ?? []), image]);
  }

  const insertConversation = sqlite.prepare(`
    INSERT INTO conversations (id, user_id, title, model, mode, created_at, updated_at)
    VALUES (@id, @userId, @title, @model, 'image', @createdAt, @updatedAt)
  `);
  const updateImageConversation = sqlite.prepare(`
    UPDATE images SET conversation_id = @conversationId WHERE id = @imageId
  `);
  const updateConversation = sqlite.prepare(`
    UPDATE conversations
    SET mode = 'image',
        model = @model,
        title = CASE WHEN title = '新会话' THEN @title ELSE title END,
        updated_at = CASE WHEN updated_at > @updatedAt THEN updated_at ELSE @updatedAt END
    WHERE id = @id
  `);
  const insertMessage = sqlite.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, model, status, parent_id, created_at, updated_at)
    VALUES (@id, @conversationId, @role, @content, @model, 'done', @parentId, @createdAt, @updatedAt)
  `);
  const findConversation = sqlite.prepare<{ id: string }, { id: string }>(`
    SELECT id FROM conversations WHERE id = @id
  `);

  const transaction = sqlite.transaction(() => {
    for (const group of groups.values()) {
      const first = group[0];
      let conversationId = first.conversation_id;
      const timestamp = first.created_at || now();
      const title = firstTitle(first.prompt);

      if (!conversationId || !findConversation.get({ id: conversationId })) {
        conversationId = crypto.randomUUID();
        insertConversation.run({
          id: conversationId,
          userId: first.user_id,
          title,
          model: env.DEFAULT_IMAGE_MODEL,
          createdAt: timestamp,
          updatedAt: timestamp
        });
      } else {
        updateConversation.run({
          id: conversationId,
          title,
          model: env.DEFAULT_IMAGE_MODEL,
          updatedAt: timestamp
        });
      }

      for (const image of group) {
        updateImageConversation.run({ conversationId, imageId: image.id });
      }

      const userMessageId = crypto.randomUUID();
      insertMessage.run({
        id: userMessageId,
        conversationId,
        role: "user",
        content: first.prompt,
        model: null,
        parentId: null,
        createdAt: timestamp,
        updatedAt: timestamp
      });
      insertMessage.run({
        id: crypto.randomUUID(),
        conversationId,
        role: "assistant",
        content: encodeImageMessage({
          prompt: first.prompt,
          images: group.map((image) => ({
            id: image.id,
            url: image.url,
            base64: image.base64
          }))
        }),
        model: first.model || env.DEFAULT_IMAGE_MODEL,
        parentId: userMessageId,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }
  });

  transaction();
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

async function seedAdminFromEnv() {
  if (hasUsers() || !env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    return;
  }

  const timestamp = now();
  const passwordHash = await bcrypt.hash(env.ADMIN_PASSWORD, 12);
  sqlite
    .prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (@id, @username, @passwordHash, 'admin', @createdAt, @updatedAt)
    `)
    .run({
      id: crypto.randomUUID(),
      username: env.ADMIN_USERNAME,
      passwordHash,
      createdAt: timestamp,
      updatedAt: timestamp
    });
}
