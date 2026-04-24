import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull().default("新会话"),
  model: text("model").notNull(),
  mode: text("mode").notNull().default("chat"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  model: text("model"),
  status: text("status").notNull().default("done"),
  parentId: text("parent_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const images = sqliteTable("images", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  conversationId: text("conversation_id"),
  prompt: text("prompt").notNull(),
  model: text("model").notNull(),
  url: text("url"),
  base64: text("base64"),
  status: text("status").notNull().default("done"),
  createdAt: integer("created_at").notNull()
});

export const models = sqliteTable("models", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  displayName: text("display_name").notNull(),
  enabled: integer("enabled").notNull().default(1),
  sort: integer("sort").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull()
});

export type UserRow = typeof users.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type ImageRow = typeof images.$inferSelect;
export type ModelRow = typeof models.$inferSelect;
