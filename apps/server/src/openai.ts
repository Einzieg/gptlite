import { env } from "./env.js";

export interface ChatApiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ImageGenerationResult {
  url: string | null;
  base64: string | null;
}

export interface ReferenceImageInput {
  name: string;
  type: string;
  data: string;
  url?: string;
}

function jsonAuthHeaders(apiKey: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function compactError(text: string) {
  return text.replace(/\s+/g, " ").slice(0, 500);
}

export async function* streamChatCompletion(params: {
  model: string;
  messages: ChatApiMessage[];
  temperature?: number;
  signal: AbortSignal;
}) {
  const response = await fetch(`${env.CHAT_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: jsonAuthHeaders(env.CHAT_API_KEY),
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      stream: true
    }),
    signal: params.signal
  });

  if (!response.ok) {
    throw new Error(`Upstream chat failed: ${response.status} ${compactError(await response.text())}`);
  }

  if (!response.body) {
    throw new Error("Upstream chat returned an empty body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      const dataLines = block
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());

      for (const data of dataLines) {
        if (!data || data === "[DONE]") {
          continue;
        }

        const parsed = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: string };
            message?: { content?: string };
            text?: string;
          }>;
        };
        const content =
          parsed.choices?.[0]?.delta?.content ??
          parsed.choices?.[0]?.message?.content ??
          parsed.choices?.[0]?.text ??
          "";
        if (content) {
          yield content;
        }
      }
    }
  }
}

export async function generateImage(params: {
  model: string;
  prompt: string;
  size: string;
  n: number;
  quality: string;
  outputFormat: string;
  outputCompression?: number;
  moderation: string;
  referenceImages?: ReferenceImageInput[];
}) {
  if (env.IMAGE_API_PROVIDER === "grsai") {
    return generateGrsaiImage(params);
  }

  return generateOpenAIImage(params);
}

async function generateOpenAIImage(params: {
  model: string;
  prompt: string;
  size: string;
  n: number;
  quality: string;
  outputFormat: string;
  outputCompression?: number;
  moderation: string;
  referenceImages?: ReferenceImageInput[];
}) {
  if (params.referenceImages?.length) {
    return editImage({ ...params, referenceImages: params.referenceImages });
  }

  const body: Record<string, unknown> = {
    model: params.model,
    prompt: params.prompt,
    size: params.size,
    quality: params.quality,
    output_format: params.outputFormat,
    moderation: params.moderation
  };

  if (params.n > 1) {
    body.n = params.n;
  }
  if (params.outputFormat !== "png" && params.outputCompression !== undefined) {
    body.output_compression = params.outputCompression;
  }

  const response = await fetch(`${env.IMAGE_API_BASE_URL}/images/generations`, {
    method: "POST",
    headers: jsonAuthHeaders(env.IMAGE_API_KEY),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Upstream image failed: ${response.status} ${compactError(await response.text())}`);
  }

  const json = (await response.json()) as {
    data?: Array<{
      url?: string;
      b64_json?: string;
    }>;
  };

  return (json.data ?? []).map<ImageGenerationResult>((item) => ({
    url: item.url ?? null,
    base64: item.b64_json ?? null
  }));
}

async function editImage(params: {
  model: string;
  prompt: string;
  size: string;
  n: number;
  quality: string;
  outputFormat: string;
  outputCompression?: number;
  moderation: string;
  referenceImages: ReferenceImageInput[];
}) {
  const formData = new FormData();
  formData.set("model", params.model);
  formData.set("prompt", params.prompt);
  formData.set("size", params.size);
  formData.set("n", String(params.n));
  formData.set("quality", params.quality);
  formData.set("output_format", params.outputFormat);
  formData.set("moderation", params.moderation);

  if (params.outputFormat !== "png" && params.outputCompression !== undefined) {
    formData.set("output_compression", String(params.outputCompression));
  }

  params.referenceImages.forEach((image) => {
    const file = referenceImageToFile(image);
    formData.append("image[]", file, file.name);
  });

  const response = await fetch(`${env.IMAGE_API_BASE_URL}/images/edits`, {
    method: "POST",
    headers: env.IMAGE_API_KEY ? { Authorization: `Bearer ${env.IMAGE_API_KEY}` } : undefined,
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Upstream image edit failed: ${response.status} ${compactError(await response.text())}`);
  }

  const json = (await response.json()) as {
    data?: Array<{
      url?: string;
      b64_json?: string;
    }>;
  };

  return (json.data ?? []).map<ImageGenerationResult>((item) => ({
    url: item.url ?? null,
    base64: item.b64_json ?? null
  }));
}

async function generateGrsaiImage(params: {
  model: string;
  prompt: string;
  size: string;
  n: number;
  quality: string;
  outputFormat: string;
  outputCompression?: number;
  moderation: string;
  referenceImages?: ReferenceImageInput[];
}) {
  const referenceUrls = (params.referenceImages ?? []).map((image) => image.url).filter(isNonEmptyString);
  if ((params.referenceImages?.length ?? 0) > referenceUrls.length) {
    throw new Error("GRSAI image references must be reachable URLs");
  }

  const body: Record<string, unknown> = {
    model: params.model,
    prompt: params.prompt,
    aspectRatio: aspectRatioFromSize(params.size),
    webHook: "-1",
    shutProgress: false
  };

  if (referenceUrls.length > 0) {
    body.urls = referenceUrls;
  }
  if (params.n > 1) {
    body.variants = params.n;
  }

  const response = await fetch(`${env.IMAGE_API_BASE_URL}/v1/draw/completions`, {
    method: "POST",
    headers: jsonAuthHeaders(env.IMAGE_API_KEY),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`GRSAI image failed: ${response.status} ${compactError(await response.text())}`);
  }

  const rawInitial = await response.text();
  const initial = parseJson(rawInitial, "GRSAI image");
  const task = normalizeGrsaiEnvelope(initial);
  const finished = isFinishedGrsaiTask(task) ? task : await pollGrsaiImageResult(task.id);

  if (finished.status === "failed") {
    throw new Error(`GRSAI image failed: ${finished.error || finished.failure_reason || "unknown error"}`);
  }

  return grsaiResultsToImages(finished);
}

async function pollGrsaiImageResult(taskId: string) {
  if (!taskId) {
    throw new Error("GRSAI image did not return a task id");
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < env.IMAGE_API_TIMEOUT_MS) {
    await delay(env.IMAGE_API_POLL_INTERVAL_MS);

    const response = await fetch(`${env.IMAGE_API_BASE_URL}/v1/draw/result`, {
      method: "POST",
      headers: jsonAuthHeaders(env.IMAGE_API_KEY),
      body: JSON.stringify({ id: taskId })
    });

    if (!response.ok) {
      throw new Error(`GRSAI image result failed: ${response.status} ${compactError(await response.text())}`);
    }

    const json = parseJson(await response.text(), "GRSAI image result");
    const task = normalizeGrsaiEnvelope(json);
    if (task.status === "failed" || isFinishedGrsaiTask(task)) {
      return task;
    }
  }

  throw new Error(`GRSAI image timed out after ${Math.round(env.IMAGE_API_TIMEOUT_MS / 1000)}s`);
}

function normalizeGrsaiEnvelope(value: unknown): GrsaiTask {
  const envelope = asObject(value);
  const code = typeof envelope.code === "number" ? envelope.code : 0;
  if (code !== 0) {
    throw new Error(`GRSAI image failed: ${typeof envelope.msg === "string" ? envelope.msg : `code ${code}`}`);
  }

  const data = asObject(envelope.data ?? value);
  return {
    id: stringValue(data.id),
    url: stringValue(data.url),
    progress: Number(data.progress ?? 0),
    results: Array.isArray(data.results) ? data.results.map(asObject) : [],
    status: stringValue(data.status),
    failure_reason: stringValue(data.failure_reason),
    error: stringValue(data.error)
  };
}

function isFinishedGrsaiTask(task: GrsaiTask) {
  return task.status === "succeeded" || (task.progress >= 100 && (task.results.length > 0 || Boolean(task.url)));
}

function grsaiResultsToImages(task: GrsaiTask) {
  const results = task.results
    .map((item) => stringValue(item.url))
    .filter(Boolean)
    .map<ImageGenerationResult>((url) => ({ url, base64: null }));

  if (results.length === 0 && task.url) {
    results.push({ url: task.url, base64: null });
  }

  if (results.length === 0) {
    throw new Error("GRSAI image completed without image URLs");
  }

  return results;
}

function aspectRatioFromSize(size: string) {
  const trimmed = size.trim();
  if (!trimmed || trimmed === "auto") {
    return "auto";
  }

  if (/^\d+:\d+$/.test(trimmed)) {
    return trimmed;
  }

  const match = trimmed.match(/^(\d+)\s*[xX×]\s*(\d+)$/);
  if (!match) {
    return trimmed;
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function gcd(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson(text: string, label: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON: ${compactError(text)}`);
  }
}

interface GrsaiTask {
  id: string;
  url: string;
  progress: number;
  results: Array<Record<string, unknown>>;
  status: string;
  failure_reason: string;
  error: string;
}

function referenceImageToFile(image: ReferenceImageInput) {
  const match = image.data.match(/^data:([^;]+);base64,(.+)$/);
  const mimeType = match?.[1] || image.type || "image/png";
  const base64 = match?.[2] || image.data;
  const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
  const filename = image.name || `reference.${extensionForMime(mimeType)}`;
  return new File([bytes], filename, { type: mimeType });
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
