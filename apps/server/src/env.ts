import "dotenv/config";

const isProduction = process.env.NODE_ENV === "production";

function requiredInProduction(name: string, fallback = "") {
  const value = process.env[name] ?? fallback;
  if (isProduction && !value) {
    throw new Error(`${name} is required in production`);
  }
  return value;
}

function booleanEnv(name: string, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return value === "1" || value.toLowerCase() === "true";
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  HOST: process.env.HOST ?? "0.0.0.0",
  PORT: Number(process.env.PORT ?? 3000),
  DATABASE_URL: process.env.DATABASE_URL ?? "file:./data/gptlite.db",
  JWT_SECRET: requiredInProduction("JWT_SECRET", "dev-secret-change-me"),
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "http://new-api:3000/v1",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
  DEFAULT_CHAT_MODEL: process.env.DEFAULT_CHAT_MODEL ?? "gpt-5.4-mini",
  DEFAULT_THINKING_MODEL: process.env.DEFAULT_THINKING_MODEL ?? "gpt-5.4",
  DEFAULT_IMAGE_MODEL: process.env.DEFAULT_IMAGE_MODEL ?? "gpt-image-2",
  ADMIN_USERNAME: process.env.ADMIN_USERNAME ?? "",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? "",
  COOKIE_SECURE: booleanEnv("COOKIE_SECURE", false)
};

export function databasePathFromUrl(databaseUrl: string) {
  if (databaseUrl.startsWith("file:")) {
    return databaseUrl.slice("file:".length);
  }
  return databaseUrl;
}

export function secureCookies() {
  return env.COOKIE_SECURE;
}
