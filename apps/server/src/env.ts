import "dotenv/config";

const isProduction = process.env.NODE_ENV === "production";
const imageApiProvider = firstNonEmpty(process.env.IMAGE_API_PROVIDER, "openai").toLowerCase();

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

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function firstNonEmpty(...values: Array<string | undefined>) {
  return values.find((value) => value !== undefined && value.trim() !== "") ?? "";
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function pathPrefix(value: string) {
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  HOST: process.env.HOST ?? "0.0.0.0",
  PORT: Number(process.env.PORT ?? 3000),
  DATABASE_URL: firstNonEmpty(process.env.DATABASE_URL, "file:./data/gptlite.db"),
  JWT_SECRET: requiredInProduction("JWT_SECRET", "dev-secret-change-me"),
  OPENAI_BASE_URL: trimTrailingSlash(firstNonEmpty(process.env.OPENAI_BASE_URL, "http://new-api:3000/v1")),
  OPENAI_API_KEY: firstNonEmpty(process.env.OPENAI_API_KEY),
  CHAT_API_BASE_URL: trimTrailingSlash(
    firstNonEmpty(process.env.CHAT_API_BASE_URL, process.env.CHAT_OPENAI_BASE_URL, process.env.OPENAI_BASE_URL, "http://new-api:3000/v1")
  ),
  CHAT_API_KEY: firstNonEmpty(process.env.CHAT_API_KEY, process.env.CHAT_OPENAI_API_KEY, process.env.OPENAI_API_KEY),
  IMAGE_API_PROVIDER: imageApiProvider,
  IMAGE_API_BASE_URL: trimTrailingSlash(
    firstNonEmpty(
      process.env.IMAGE_API_BASE_URL,
      process.env.IMAGE_OPENAI_BASE_URL,
      imageApiProvider === "grsai" ? "https://grsaiapi.com" : firstNonEmpty(process.env.OPENAI_BASE_URL, "http://new-api:3000/v1")
    )
  ),
  IMAGE_API_KEY: firstNonEmpty(process.env.IMAGE_API_KEY, process.env.IMAGE_OPENAI_API_KEY, process.env.OPENAI_API_KEY),
  IMAGE_API_POLL_INTERVAL_MS: numberEnv("IMAGE_API_POLL_INTERVAL_MS", 2500),
  IMAGE_API_TIMEOUT_MS: numberEnv("IMAGE_API_TIMEOUT_MS", 300000),
  PUBLIC_APP_URL: trimTrailingSlash(firstNonEmpty(process.env.PUBLIC_APP_URL)),
  REFERENCE_IMAGE_DIR: firstNonEmpty(process.env.REFERENCE_IMAGE_DIR, "./data/reference-images"),
  REFERENCE_IMAGE_PUBLIC_PATH: pathPrefix(firstNonEmpty(process.env.REFERENCE_IMAGE_PUBLIC_PATH, "/public/reference-images/")),
  DEFAULT_CHAT_MODEL: firstNonEmpty(process.env.DEFAULT_CHAT_MODEL, "gpt-5.4-mini"),
  DEFAULT_THINKING_MODEL: firstNonEmpty(process.env.DEFAULT_THINKING_MODEL, "gpt-5.4"),
  DEFAULT_IMAGE_MODEL: firstNonEmpty(process.env.DEFAULT_IMAGE_MODEL, "gpt-image-2"),
  ADMIN_USERNAME: firstNonEmpty(process.env.ADMIN_USERNAME),
  ADMIN_PASSWORD: firstNonEmpty(process.env.ADMIN_PASSWORD),
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
