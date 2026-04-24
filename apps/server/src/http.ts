import type { FastifyReply } from "fastify";

export function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: message });
}

export function notFound(reply: FastifyReply, message = "Not found") {
  return reply.code(404).send({ error: message });
}

export function forbidden(reply: FastifyReply, message = "Forbidden") {
  return reply.code(403).send({ error: message });
}

export function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({ error: "Unauthorized" });
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function stringBody(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}
