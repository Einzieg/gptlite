import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { clearSessionCookie, hashPassword, setSessionCookie, toSafeUser, verifyPassword, getCurrentUser } from "../auth.js";
import { db, hasUsers, now } from "../db/client.js";
import { users } from "../db/schema.js";
import { asRecord, badRequest } from "../http.js";

export async function authRoutes(app: FastifyInstance) {
  app.get("/api/auth/me", async (request) => {
    const user = await getCurrentUser(request);
    return { user, setupRequired: !hasUsers() };
  });

  app.post("/api/auth/setup", async (request, reply) => {
    if (hasUsers()) {
      return reply.code(409).send({ error: "Admin already initialized" });
    }

    const body = asRecord(request.body);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (username.length < 2 || password.length < 8) {
      return badRequest(reply, "用户名至少 2 位，密码至少 8 位");
    }

    const timestamp = now();
    const user = {
      id: crypto.randomUUID(),
      username,
      passwordHash: await hashPassword(password),
      role: "admin",
      createdAt: timestamp,
      updatedAt: timestamp
    };

    db.insert(users).values(user).run();
    await setSessionCookie(reply, user.id);
    return { user: toSafeUser(user) };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = asRecord(request.body);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const user = db.select().from(users).where(eq(users.username, username)).get();

    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return reply.code(401).send({ error: "用户名或密码错误" });
    }

    await setSessionCookie(reply, user.id);
    return { user: toSafeUser(user) };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });
}
