import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { initializeDatabase } from "./db/client.js";
import { env } from "./env.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { chatRoutes } from "./routes/chat.js";
import { conversationRoutes } from "./routes/conversations.js";
import { imageRoutes } from "./routes/images.js";

const app = Fastify({
  logger: {
    level: env.NODE_ENV === "production" ? "info" : "debug"
  }
});

await initializeDatabase();

mkdirSync(env.REFERENCE_IMAGE_DIR, { recursive: true });
await app.register(fastifyStatic, {
  root: env.REFERENCE_IMAGE_DIR,
  prefix: env.REFERENCE_IMAGE_PUBLIC_PATH,
  decorateReply: false,
  maxAge: "2h"
});

await app.register(cookie);
await app.register(authRoutes);
await app.register(conversationRoutes);
await app.register(chatRoutes);
await app.register(imageRoutes);
await app.register(adminRoutes);

app.get("/api/health", async () => ({ ok: true }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDist = join(__dirname, "../../web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, {
    root: webDist,
    prefix: "/"
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.sendFile("index.html");
  });
}

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
