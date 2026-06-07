import { requestJson } from "./http.js";
import type { GlobalOptions, HackClubModel, ModelsResponse, ReplicateCategory } from "./types.js";

const REPLICATE_ALLOWLIST_URL =
  "https://raw.githubusercontent.com/hackclub/ai/main/src/config/replicate-models.ts";

const FALLBACK_REPLICATE_CATEGORIES: ReplicateCategory[] = [
  {
    name: "Text to Speech",
    models: [
      { id: "minimax/speech-02-turbo", costPerRequest: 0.0045 },
      { id: "minimax/speech-2.8-turbo", costPerRequest: 0.04 },
      { id: "minimax/speech-2.8-hd", costPerRequest: 0.08 },
      { id: "resemble-ai/chatterbox-pro", costPerRequest: 0.07 },
      { id: "zsxkib/dia", costPerRequest: 0.069 },
      { id: "lucataco/xtts-v2", costPerRequest: 0.053 },
      { id: "qwen/qwen3-tts", costPerRequest: 0.06 },
      { id: "inworld/tts-1.5-mini", costPerRequest: 0.0175 },
      { id: "inworld/tts-1.5-max", costPerRequest: 0.035 },
    ],
  },
  {
    name: "Speech to Text",
    models: [
      { id: "vaibhavs10/incredibly-fast-whisper", costPerRequest: 0.02 },
      { id: "nvidia/parakeet-rnnt-1.1b", costPerRequest: 0.02 },
    ],
  },
  {
    name: "OCR",
    models: [
      { id: "cuuupid/glm-4v-9b", costPerRequest: 0.13 },
      { id: "lucataco/deepseek-ocr", costPerRequest: 0.0063 },
      { id: "abiruyt/text-extract-ocr", costPerRequest: 0.0019 },
    ],
  },
  {
    name: "Image Upscaling",
    models: [
      { id: "fermatresearch/magic-image-refiner", costPerRequest: 0.029 },
      { id: "recraft-ai/recraft-crisp-upscale", costPerRequest: 0.006 },
      { id: "google/upscaler", costPerRequest: 0.01 },
    ],
  },
  {
    name: "Image Utilities",
    models: [
      { id: "lucataco/remove-bg", costPerRequest: 0.00028 },
      { id: "851-labs/background-remover", costPerRequest: 0.00052 },
      { id: "zsxkib/ic-light-background", costPerRequest: 0.029 },
      { id: "arielreplicate/robust_video_matting", costPerRequest: 0.046 },
      { id: "lucataco/rembg-video", costPerRequest: 0.1 },
      { id: "falcons-ai/nsfw_image_detection", costPerRequest: 0.0003 },
    ],
  },
  {
    name: "Music Generation",
    models: [
      { id: "google/lyria-2", costPerRequest: 0.12 },
      { id: "meta/musicgen", costPerRequest: 0.076 },
      { id: "minimax/music-1.5", costPerRequest: 0.03 },
    ],
  },
  {
    name: "Specialized Image Models",
    models: [{ id: "retro-diffusion/rd-plus", costPerRequest: 0.06 }],
  },
  {
    name: "Audio",
    models: [
      { id: "geopti/sam-audio-large", costPerRequest: 0.07 },
      { id: "minimax/voice-cloning", costPerRequest: 3.0 },
    ],
  },
];

export async function fetchRegularModels(options: GlobalOptions): Promise<HackClubModel[]> {
  const response = await requestJson<ModelsResponse>(options, { path: "/models", auth: false });
  return dedupeModels(response.data || []);
}

function dedupeModels(models: HackClubModel[]): HackClubModel[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

export async function fetchEmbeddingModels(options: GlobalOptions): Promise<HackClubModel[]> {
  const response = await requestJson<ModelsResponse>(options, { path: "/embeddings/models", auth: false });
  return response.data || [];
}

export async function fetchReplicateCategories(): Promise<ReplicateCategory[]> {
  try {
    const response = await fetch(REPLICATE_ALLOWLIST_URL, {
      headers: { "User-Agent": "hcai-cli/0.2.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return FALLBACK_REPLICATE_CATEGORIES;
    const source = await response.text();
    const parsed = parseReplicateSource(source);
    return parsed.length > 0 ? parsed : FALLBACK_REPLICATE_CATEGORIES;
  } catch {
    return FALLBACK_REPLICATE_CATEGORIES;
  }
}

export function classifyRegularModel(model: HackClubModel): "image" | "chat" {
  const modality = model.architecture?.modality || "";
  const outputs = model.architecture?.output_modalities || [];
  if (modality.includes("image") && outputs.includes("image")) return "image";
  if (outputs.includes("image")) return "image";
  return "chat";
}

export function flattenReplicate(categories: ReplicateCategory[]): Array<{
  id: string;
  type: "replicate";
  category: string;
  costPerRequest: number;
}> {
  return categories.flatMap((category) =>
    category.models.map((model) => ({
      id: model.id,
      type: "replicate" as const,
      category: category.name,
      costPerRequest: model.costPerRequest,
    })),
  );
}

function parseReplicateSource(source: string): ReplicateCategory[] {
  const categories: ReplicateCategory[] = [];
  const categoryRegex = /\{\s*name:\s*"([^"]+)"\s*,\s*models:\s*\[([\s\S]*?)\]\s*,?\s*\}/g;
  let categoryMatch: RegExpExecArray | null;

  while ((categoryMatch = categoryRegex.exec(source))) {
    const name = categoryMatch[1];
    const body = categoryMatch[2] || "";
    const models = [...body.matchAll(/\{\s*id:\s*"([^"]+)"\s*,\s*costPerRequest:\s*([0-9.]+)\s*,?\s*\}/g)].map(
      (match) => ({
        id: match[1] || "",
        costPerRequest: Number(match[2]),
      }),
    );

    if (name && models.length > 0) categories.push({ name, models });
  }

  return categories;
}
