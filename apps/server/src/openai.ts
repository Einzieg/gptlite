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
}

function authHeaders() {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (env.OPENAI_API_KEY) {
    headers.Authorization = `Bearer ${env.OPENAI_API_KEY}`;
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
  const response = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
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
  referenceImages?: ReferenceImageInput[];
}) {
  if (params.referenceImages?.length) {
    return editImage({ ...params, referenceImages: params.referenceImages });
  }

  const response = await fetch(`${env.OPENAI_BASE_URL}/images/generations`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: params.model,
      prompt: params.prompt,
      size: params.size,
      n: params.n
    })
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
  referenceImages: ReferenceImageInput[];
}) {
  const formData = new FormData();
  formData.set("model", params.model);
  formData.set("prompt", params.prompt);
  formData.set("size", params.size);
  formData.set("n", String(params.n));

  params.referenceImages.forEach((image) => {
    const file = referenceImageToFile(image);
    formData.append(params.referenceImages.length === 1 ? "image" : "image[]", file, file.name);
  });

  const response = await fetch(`${env.OPENAI_BASE_URL}/images/edits`, {
    method: "POST",
    headers: env.OPENAI_API_KEY ? { Authorization: `Bearer ${env.OPENAI_API_KEY}` } : undefined,
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
