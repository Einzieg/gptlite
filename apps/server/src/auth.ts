import type { FastifyReply, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { db } from "./db/client.js";
import { users, type UserRow } from "./db/schema.js";
import { env, secureCookies } from "./env.js";
import { forbidden, unauthorized } from "./http.js";

export interface SafeUser {
  id: string;
  username: string;
  role: "admin" | "user";
  createdAt: number;
  updatedAt: number;
}

const SESSION_COOKIE = "gptlite_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const jwtSecret = new TextEncoder().encode(env.JWT_SECRET);

export function toSafeUser(user: UserRow): SafeUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role === "admin" ? "admin" : "user",
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

async function signSession(userId: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(jwtSecret);
}

async function verifySession(token: string) {
  const result = await jwtVerify(token, jwtSecret);
  return result.payload.sub;
}

export async function setSessionCookie(reply: FastifyReply, userId: string) {
  const token = await signSession(userId);
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    maxAge: SESSION_MAX_AGE_SECONDS
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: "/", secure: secureCookies(), sameSite: "lax" });
}

export async function getCurrentUser(request: FastifyRequest) {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) {
    return null;
  }

  try {
    const userId = await verifySession(token);
    if (!userId) {
      return null;
    }

    const user = db.select().from(users).where(eq(users.id, userId)).get();
    return user ? toSafeUser(user) : null;
  } catch {
    return null;
  }
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = await getCurrentUser(request);
  if (!user) {
    unauthorized(reply);
    return null;
  }
  return user;
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  const user = await requireUser(request, reply);
  if (!user) {
    return null;
  }
  if (user.role !== "admin") {
    forbidden(reply);
    return null;
  }
  return user;
}
