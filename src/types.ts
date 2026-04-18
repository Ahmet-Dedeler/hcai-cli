export type OutputMode = "text" | "json";

export type GlobalOptions = {
  apiKey?: string;
  baseUrl: string;
  output: OutputMode;
  timeout: number;
  verbose: boolean;
};

export type ConfigFile = {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type HackClubModel = {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: Record<string, string>;
  supported_parameters?: string[];
};

export type ModelsResponse = {
  data: HackClubModel[];
};

export type ReplicateModelConfig = {
  id: string;
  costPerRequest: number;
};

export type ReplicateCategory = {
  name: string;
  models: ReplicateModelConfig[];
};

export class HcaiError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "HcaiError";
  }
}
