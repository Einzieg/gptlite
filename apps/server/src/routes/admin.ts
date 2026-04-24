import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { hashPassword, requireAdmin, toSafeUser } from "../auth.js";
import { db, now } from "../db/client.js";
import { models, settings, users } from "../db/schema.js";
import { asRecord, badRequest, notFound, stringBody } from "../http.js";

export async function adminRoutes(app: FastifyInstance) {
  app.get("/api/admin/users", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    return db.select().from(users).all().map(toSafeUser);
  });

  app.post("/api/admin/users", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const body = asRecord(request.body);
    const username = stringBody(body.username);
    const password = typeof body.password === "string" ? body.password : "";
    const role = body.role === "admin" ? "admin" : "user";
    if (username.length < 2 || password.length < 8) {
      return badRequest(reply, "用户名至少 2 位，密码至少 8 位");
    }

    const timestamp = now();
    const user = {
      id: crypto.randomUUID(),
      username,
      passwordHash: await hashPassword(password),
      role,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    try {
      db.insert(users).values(user).run();
      return toSafeUser(user);
    } catch {
      return badRequest(reply, "用户名已存在");
    }
  });

  app.patch("/api/admin/users/:id", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const { id } = request.params as { id: string };
    const body = asRecord(request.body);
    const patch: { username?: string; role?: string; passwordHash?: string; updatedAt: number } = {
      updatedAt: now()
    };

    if (typeof body.username === "string") {
      patch.username = body.username.trim();
    }
    if (body.role === "admin" || body.role === "user") {
      patch.role = body.role;
    }
    if (typeof body.password === "string" && body.password.length > 0) {
      if (body.password.length < 8) {
        return badRequest(reply, "密码至少 8 位");
      }
      patch.passwordHash = await hashPassword(body.password);
    }

    const result = db.update(users).set(patch).where(eq(users.id, id)).run();
    if (result.changes === 0) {
      return notFound(reply, "用户不存在");
    }

    const user = db.select().from(users).where(eq(users.id, id)).get();
    return user ? toSafeUser(user) : notFound(reply, "用户不存在");
  });

  app.delete("/api/admin/users/:id", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const { id } = request.params as { id: string };
    if (id === admin.id) {
      return badRequest(reply, "不能删除当前管理员");
    }

    const result = db.delete(users).where(eq(users.id, id)).run();
    if (result.changes === 0) {
      return notFound(reply, "用户不存在");
    }
    return { ok: true };
  });

  app.get("/api/admin/models", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }
    return db.select().from(models).all();
  });

  app.post("/api/admin/models", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const body = asRecord(request.body);
    const id = stringBody(body.id);
    const type = body.type === "image" || body.type === "reasoning" ? body.type : "chat";
    const displayName = stringBody(body.displayName, id);
    if (!id || !displayName) {
      return badRequest(reply, "模型 ID 和名称不能为空");
    }
    if (isDeprecatedModel(id)) {
      return badRequest(reply, "gpt-4* 模型已下架，不能添加");
    }

    const timestamp = now();
    const model = {
      id,
      type,
      displayName,
      enabled: body.enabled === false ? 0 : 1,
      sort: Number(body.sort ?? 0),
      createdAt: timestamp,
      updatedAt: timestamp
    };

    try {
      db.insert(models).values(model).run();
      return model;
    } catch {
      return badRequest(reply, "模型已存在");
    }
  });

  app.patch("/api/admin/models/:id", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const { id } = request.params as { id: string };
    if (isDeprecatedModel(id)) {
      return badRequest(reply, "gpt-4* 模型已下架，不能启用或修改");
    }
    const body = asRecord(request.body);
    const patch: {
      type?: string;
      displayName?: string;
      enabled?: number;
      sort?: number;
      updatedAt: number;
    } = { updatedAt: now() };

    if (body.type === "chat" || body.type === "image" || body.type === "reasoning") {
      patch.type = body.type;
    }
    if (typeof body.displayName === "string") {
      patch.displayName = body.displayName.trim();
    }
    if (typeof body.enabled === "boolean") {
      patch.enabled = body.enabled ? 1 : 0;
    }
    if (body.sort !== undefined) {
      patch.sort = Number(body.sort);
    }

    const result = db.update(models).set(patch).where(eq(models.id, id)).run();
    if (result.changes === 0) {
      return notFound(reply, "模型不存在");
    }
    return db.select().from(models).where(eq(models.id, id)).get();
  });

  app.delete("/api/admin/models/:id", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const { id } = request.params as { id: string };
    const result = db.delete(models).where(eq(models.id, id)).run();
    if (result.changes === 0) {
      return notFound(reply, "模型不存在");
    }
    return { ok: true };
  });

  app.get("/api/admin/settings", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }
    return Object.fromEntries(db.select().from(settings).all().map((setting) => [setting.key, setting.value]));
  });

  app.patch("/api/admin/settings", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const body = asRecord(request.body);
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") {
        db.insert(settings)
          .values({ key, value })
          .onConflictDoUpdate({ target: settings.key, set: { value } })
          .run();
      }
    }

    return Object.fromEntries(db.select().from(settings).all().map((setting) => [setting.key, setting.value]));
  });
}

function isDeprecatedModel(id: string) {
  return id.toLowerCase().startsWith("gpt-4");
}
