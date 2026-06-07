#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  getConfigPath,
  maskKey,
  readConfig,
  removeConfig,
  requireApiKey,
  resolveGlobalOptions,
  writeConfig,
} from "./config.js";
import { request, requestForm, requestJson } from "./http.js";
import { dataUrlExtension, downloadUrl, print, readText, writeBinaryDataUrl } from "./io.js";
import {
  classifyRegularModel,
  fetchEmbeddingModels,
  fetchRegularModels,
  fetchReplicateCategories,
  flattenReplicate,
} from "./models.js";
import type { ChatMessage, GlobalOptions, HackClubModel, ModelsResponse, OutputMode } from "./types.js";
import { HcaiError } from "./types.js";

const program = new Command();

program
  .name("hcai")
  .description("Agent-friendly CLI for Hack Club AI and its Replicate proxy.")
  .version("0.2.0")
  .option("--api-key <key>", "Hack Club AI API key. Also reads HCAI_API_KEY, HACKCLUB_AI_API_KEY, HACK_CLUB_AI_KEY, or REPLICATE_API_TOKEN.")
  .option("--base-url <url>", "Hack Club AI proxy base URL.", "https://ai.hackclub.com/proxy/v1")
  .option("-o, --output <mode>", "Output mode: text or json.", "text")
  .option("--timeout <seconds>", "Request timeout in seconds.", "300")
  .option("--verbose", "Print request diagnostics to stderr.");

const getOptions = (): GlobalOptions => {
  const raw = program.opts<{
    apiKey?: string;
    baseUrl?: string;
    output?: OutputMode;
    timeout?: string;
    verbose?: boolean;
  }>();
  if (raw.output !== "text" && raw.output !== "json") {
    throw new HcaiError("Invalid --output. Use `text` or `json`.", 2);
  }
  return resolveGlobalOptions(raw);
};

const auth = program.command("auth").description("Manage local Hack Club AI API key config.");

auth
  .command("login")
  .description("Save an API key to ~/.hcai/config.json.")
  .option("--api-key <key>", "Hack Club AI API key.")
  .action((flags: { apiKey: string }) => {
    const apiKey = flags.apiKey || program.opts<{ apiKey?: string }>().apiKey;
    if (!apiKey) {
      throw new HcaiError("No API key provided.", 2, "Run: hcai auth login --api-key sk-hc-v1-...");
    }
    const current = readConfig();
    writeConfig({ ...current, apiKey });
    print({ status: "saved", configPath: getConfigPath(), apiKey: maskKey(apiKey) }, getOptions().output);
  });

auth
  .command("status")
  .description("Show where the active API key is coming from.")
  .action(() => {
    const options = getOptions();
    const envKey =
      process.env.HCAI_API_KEY ||
      process.env.HACKCLUB_AI_API_KEY ||
      process.env.HACK_CLUB_AI_KEY ||
      process.env.REPLICATE_API_TOKEN;
    const config = readConfig();
    const key = options.apiKey;
    print(
      {
        authenticated: Boolean(key),
        source: program.opts().apiKey ? "flag" : envKey ? "environment" : config.apiKey ? getConfigPath() : null,
        apiKey: key ? maskKey(key) : null,
        baseUrl: options.baseUrl,
      },
      options.output,
    );
  });

auth
  .command("logout")
  .description("Remove ~/.hcai/config.json.")
  .action(() => {
    removeConfig();
    print({ status: "removed", configPath: getConfigPath() }, getOptions().output);
  });

const models = program.command("models").description("List or inspect available models.");

models
  .command("list", { isDefault: true })
  .description("List available chat, image, embedding, Replicate, or task-specific models.")
  .option("-t, --type <type>", "all, chat, image, embedding, replicate, text-to-speech, speech-to-text, music, audio, ocr, image-utility, or image-upscaling.", "all")
  .option("--details", "Include descriptions and supported parameter counts.")
  .action(async (flags: { type: string; details?: boolean }) => {
    const options = getOptions();
    const type = normalizeModelType(flags.type);
    const rows: Array<Record<string, unknown>> = [];

    if (type === "all" || type === "chat" || type === "image") {
      const regular = await fetchRegularModels(options);
      for (const model of regular) {
        const modelType = classifyRegularModel(model);
        if (type !== "all" && type !== modelType) continue;
        rows.push(modelRow(model, modelType, flags.details));
      }
    }

    if (type === "all" || type === "embedding") {
      const embedding = await fetchEmbeddingModels(options);
      for (const model of embedding) rows.push(modelRow(model, "embedding", flags.details));
    }

    if (type === "all" || type === "replicate" || isReplicateCategoryType(type)) {
      const replicate = flattenReplicate(await fetchReplicateCategories());
      for (const model of replicate) {
        if (isReplicateCategoryType(type) && categoryType(model.category) !== type) continue;
        rows.push({
          id: model.id,
          type: model.type,
          category: model.category,
          costPerRequest: model.costPerRequest,
        });
      }
    }

    print(rows, options.output);
  });

models
  .command("info")
  .description("Inspect a regular or Replicate model.")
  .argument("<model>", "Model ID, e.g. qwen/qwen3-32b or resemble-ai/chatterbox-pro.")
  .option("--replicate", "Treat the model ID as a Replicate model and query Replicate metadata.")
  .action(async (model: string, flags: { replicate?: boolean }) => {
    const options = getOptions();
    if (flags.replicate) {
      const [owner, name] = splitModelId(model);
      const data = await requestJson<unknown>(options, { path: `/replicate/models/${owner}/${name}` });
      print(data, options.output);
      return;
    }

    const all = [...(await fetchRegularModels(options)), ...(await fetchEmbeddingModels(options))];
    const found = all.find((entry) => entry.id === model);
    if (!found) throw new HcaiError(`Model not found in live regular model list: ${model}`, 1, "For Replicate metadata, use: hcai models info --replicate owner/model");
    print(found, options.output);
  });

program
  .command("chat")
  .description("Run a chat completion.")
  .argument("[prompt...]", "Prompt text. If omitted, stdin is used.")
  .option("-m, --model <model>", "Model ID.", "google/gemini-3.5-flash")
  .option("--message <message>", "Additional user message. Repeatable.", collect, [])
  .option("--system <text>", "System prompt.")
  .option("--file <path>", "Read prompt from a file, or '-' for stdin.")
  .option("--temperature <number>", "Sampling temperature.")
  .option("--max-tokens <number>", "Maximum output tokens.")
  .option("--reasoning", "Allow OpenRouter reasoning tokens for models that support thinking.")
  .option("--stream", "Stream assistant text as it arrives.")
  .option("--raw", "Print the raw API response instead of extracting assistant text.")
  .action(async (promptParts: string[], flags: Record<string, unknown>) => {
    const options = getOptions();
    const prompt = await readText(promptParts.join(" ") || undefined, flags.file as string | undefined);
    const messages: ChatMessage[] = [];
    if (typeof flags.system === "string") messages.push({ role: "system", content: flags.system });
    messages.push({ role: "user", content: prompt });
    for (const message of (flags.message as string[] | undefined) || []) {
      messages.push({ role: "user", content: message });
    }

    const body: Record<string, unknown> = {
      model: flags.model,
      messages,
      stream: Boolean(flags.stream),
    };
    if (!flags.reasoning) {
      body.include_reasoning = false;
      body.reasoning = { enabled: false, exclude: true };
    }
    maybeNumber(body, "temperature", flags.temperature);
    maybeNumber(body, "max_tokens", flags.maxTokens);

    if (flags.stream) {
      const response = await request(options, { method: "POST", path: "/chat/completions", body });
      await streamChatResponse(response, options.output === "json");
      return;
    }

    const data = await requestJson<Record<string, unknown>>(options, { method: "POST", path: "/chat/completions", body });
    if (flags.raw || options.output === "json") print(data, options.output);
    else print(extractAssistantText(data), "text");
  });

program
  .command("image")
  .description("Generate an image through Hack Club AI image-capable chat models.")
  .argument("[prompt...]", "Image prompt. If omitted, stdin is used.")
  .option("-m, --model <model>", "Image model ID.", "google/gemini-3.1-flash-image-preview")
  .option("--file <path>", "Read prompt from a file, or '-' for stdin.")
  .option("--aspect-ratio <ratio>", "Aspect ratio, e.g. 1:1, 16:9, 9:16.", "1:1")
  .option("--out <path>", "Write the first image to a specific local file.")
  .option("--out-dir <dir>", "Directory for generated image files. Defaults to current directory.", ".")
  .option("--out-prefix <prefix>", "Filename prefix when using --out-dir.", "image")
  .option("--raw", "Print raw API response with base64 data URLs.")
  .action(async (promptParts: string[], flags: Record<string, unknown>) => {
    const options = getOptions();
    const prompt = await readText(promptParts.join(" ") || undefined, flags.file as string | undefined);
    const body = {
      model: flags.model,
      messages: [{ role: "user", content: prompt }],
      modalities: ["image", "text"],
      image_config: { aspect_ratio: flags.aspectRatio },
      stream: false,
    };

    const data = await requestJson<Record<string, unknown>>(options, { method: "POST", path: "/chat/completions", body });
    if (flags.raw) {
      print(data, options.output);
      return;
    }
    const result = extractImages(data);
    const saved = saveExtractedImages(result.images, {
      out: flags.out as string | undefined,
      outDir: String(flags.outDir || "."),
      outPrefix: String(flags.outPrefix || "image"),
    });
    print({ content: result.content, saved, count: saved.length }, options.output);
  });

program
  .command("embed")
  .description("Generate embeddings for text.")
  .argument("[text...]", "Text to embed. If omitted, stdin is used.")
  .option("-m, --model <model>", "Embedding model ID.", "openai/text-embedding-3-large")
  .option("--file <path>", "Read text from a file, or '-' for stdin.")
  .action(async (textParts: string[], flags: Record<string, unknown>) => {
    const options = { ...getOptions(), output: "json" as const };
    const input = await readText(textParts.join(" ") || undefined, flags.file as string | undefined);
    const data = await requestJson<unknown>(options, {
      method: "POST",
      path: "/embeddings",
      body: { model: flags.model, input },
    });
    print(data, options.output);
  });

const speech = program.command("speech").description("Speech tools backed by Hack Club AI Replicate models.");

speech
  .command("synthesize")
  .alias("generate")
  .description("Generate speech/audio from text.")
  .argument("[text...]", "Text to synthesize. If omitted, stdin is used.")
  .option("-m, --model <model>", "Text-to-speech Replicate model.", "minimax/speech-02-turbo")
  .option("--text <text>", "Text to synthesize.")
  .option("--text-file <path>", "Read text from a file, or '-' for stdin.")
  .option("--voice <id>", "Voice ID/name. MiniMax default: Deep_Voice_Man.", "Deep_Voice_Man")
  .option("--emotion <emotion>", "MiniMax emotion, e.g. auto, happy, sad, angry.", "auto")
  .option("--language <language>", "MiniMax language boost.", "English")
  .option("--speed <number>", "Speech speed multiplier.")
  .option("--volume <number>", "Speech volume.")
  .option("--pitch <number>", "Speech pitch.")
  .option("--format <format>", "Audio format, usually mp3 or wav.", "mp3")
  .option("--sample-rate <hz>", "Sample rate in Hz.")
  .option("--bitrate <bps>", "Bitrate in bps.")
  .option("--channel <channel>", "mono or stereo.", "mono")
  .option("--subtitles", "Request subtitle/timing metadata if the model supports it.")
  .option("--input <json>", "Extra model input JSON merged into the generated input.")
  .option("--out <path>", "Save audio to this file. Defaults to speech_<timestamp>.<format>.")
  .option("--raw", "Print raw prediction response without downloading.")
  .action(runSpeechSynthesize);

program
  .command("tts")
  .description("Alias for `hcai speech synthesize`.")
  .argument("[text...]", "Text to synthesize. If omitted, stdin is used.")
  .option("-m, --model <model>", "Text-to-speech Replicate model.", "minimax/speech-02-turbo")
  .option("--text <text>", "Text to synthesize.")
  .option("--text-file <path>", "Read text from a file, or '-' for stdin.")
  .option("--voice <id>", "Voice ID/name. MiniMax default: Deep_Voice_Man.", "Deep_Voice_Man")
  .option("--emotion <emotion>", "MiniMax emotion, e.g. auto, happy, sad, angry.", "auto")
  .option("--language <language>", "MiniMax language boost.", "English")
  .option("--speed <number>", "Speech speed multiplier.")
  .option("--volume <number>", "Speech volume.")
  .option("--pitch <number>", "Speech pitch.")
  .option("--format <format>", "Audio format, usually mp3 or wav.", "mp3")
  .option("--out <path>", "Save audio to this file. Defaults to speech_<timestamp>.<format>.")
  .option("--raw", "Print raw prediction response without downloading.")
  .action(runSpeechSynthesize);

speech
  .command("transcribe")
  .description("Transcribe or translate speech from an audio URL or local file.")
  .requiredOption("--audio <url-or-path>", "Audio URL or local audio file path.")
  .option("-m, --model <model>", "Speech-to-text Replicate model.", "vaibhavs10/incredibly-fast-whisper")
  .option("--task <task>", "Whisper task: transcribe or translate.", "transcribe")
  .option("--language <language>", "Spoken language hint, or None for auto.", "None")
  .option("--timestamp <mode>", "Whisper timestamp mode, e.g. chunk or word.", "chunk")
  .option("--batch-size <number>", "Whisper batch size.")
  .option("--diarize", "Enable diarization for incredibly-fast-whisper.")
  .option("--hf-token <token>", "Hugging Face token for diarization.")
  .option("--out <path>", "Write extracted transcript text to a file.")
  .option("--raw", "Print raw prediction response.")
  .action(runSpeechTranscribe);

program
  .command("stt")
  .description("Alias for `hcai speech transcribe`.")
  .requiredOption("--audio <url-or-path>", "Audio URL or local audio file path.")
  .option("-m, --model <model>", "Speech-to-text Replicate model.", "vaibhavs10/incredibly-fast-whisper")
  .option("--task <task>", "Whisper task: transcribe or translate.", "transcribe")
  .option("--language <language>", "Spoken language hint, or None for auto.", "None")
  .option("--timestamp <mode>", "Whisper timestamp mode, e.g. chunk or word.", "chunk")
  .option("--out <path>", "Write extracted transcript text to a file.")
  .option("--raw", "Print raw prediction response.")
  .action(runSpeechTranscribe);

const music = program.command("music").description("Music generation tools backed by Hack Club AI Replicate models.");

music
  .command("generate")
  .description("Generate music from a prompt.")
  .argument("[prompt...]", "Music prompt. If omitted, stdin is used.")
  .option("-m, --model <model>", "Music Replicate model.", "google/lyria-2")
  .option("--prompt <text>", "Music prompt.")
  .option("--prompt-file <path>", "Read prompt from a file, or '-' for stdin.")
  .option("--negative-prompt <text>", "What to avoid. Supported by google/lyria-2.")
  .option("--lyrics <text>", "Lyrics. Required by minimax/music-1.5.")
  .option("--lyrics-file <path>", "Read lyrics from a file, or '-' for stdin.")
  .option("--duration <seconds>", "Duration in seconds. Supported by meta/musicgen.")
  .option("--seed <number>", "Random seed.")
  .option("--input-audio <url-or-path>", "Reference audio URL/path for meta/musicgen melody/continuation.")
  .option("--continuation", "Continue from --input-audio for meta/musicgen.")
  .option("--format <format>", "Output format hint, e.g. mp3 or wav.")
  .option("--input <json>", "Extra model input JSON merged into the generated input.")
  .option("--out <path>", "Save generated audio to this file. Defaults to music_<timestamp>.<ext>.")
  .option("--raw", "Print raw prediction response without downloading.")
  .action(runMusicGenerate);

program
  .command("stats")
  .description("Show token and spend stats for the active API key.")
  .action(async () => {
    const options = getOptions();
    const data = await requestJson<unknown>(options, { path: "/stats" });
    print(data, options.output);
  });

program
  .command("ocr")
  .description("Run Mistral OCR through Hack Club AI (closed beta).")
  .option("--image-url <url>", "HTTPS image URL or base64 data URI.")
  .option("--document-url <url>", "HTTPS document URL or base64 data URI.")
  .option("--file-id <id>", "Mistral file ID.")
  .option("-m, --model <model>", "OCR model.", "mistral-ocr-latest")
  .option("--pages <pages>", "Comma-separated page numbers to process.")
  .option("--table-format <format>", "markdown or html.", "markdown")
  .option("--include-image-base64", "Include base64 image payloads in the response.")
  .option("--body <json>", "Full OCR request JSON. Overrides document flags.")
  .option("--body-file <path>", "Read full OCR request JSON from a file, or '-' for stdin.")
  .action(async (flags: Record<string, unknown>) => {
    const options = getOptions();
    const body = await resolveOcrBody(flags);
    const data = await requestJson<unknown>(options, { method: "POST", path: "/ocr", body });
    print(data, options.output);
  });

program
  .command("moderate")
  .alias("moderations")
  .description("Run OpenAI moderation through Hack Club AI.")
  .argument("[text...]", "Text to moderate. If omitted, stdin is used.")
  .option("--input <text>", "Text to moderate.")
  .option("--file <path>", "Read text from a file, or '-' for stdin.")
  .option("-m, --model <model>", "Moderation model.", "omni-moderation-latest")
  .action(async (textParts: string[], flags: Record<string, unknown>) => {
    const options = getOptions();
    const input = await readText(
      (flags.input as string | undefined) || textParts.join(" ") || undefined,
      flags.file as string | undefined,
    );
    const data = await requestJson<unknown>(options, {
      method: "POST",
      path: "/moderations",
      body: { model: flags.model, input },
    });
    print(data, options.output);
  });

program
  .command("responses")
  .description("Run an OpenAI-style /responses request through Hack Club AI.")
  .argument("[prompt...]", "Prompt text. If omitted, stdin is used.")
  .option("-m, --model <model>", "Model ID.", "google/gemini-3.5-flash")
  .option("--system <text>", "System instructions.")
  .option("--file <path>", "Read prompt from a file, or '-' for stdin.")
  .option("--temperature <number>", "Sampling temperature.")
  .option("--max-tokens <number>", "Maximum output tokens.")
  .option("--reasoning", "Allow reasoning tokens for models that support thinking.")
  .option("--stream", "Stream assistant text as it arrives.")
  .option("--raw", "Print the raw API response.")
  .action(async (promptParts: string[], flags: Record<string, unknown>) => {
    const options = getOptions();
    const prompt = await readText(promptParts.join(" ") || undefined, flags.file as string | undefined);
    const body: Record<string, unknown> = {
      model: flags.model,
      input: prompt,
      stream: Boolean(flags.stream),
    };
    if (typeof flags.system === "string") body.instructions = flags.system;
    if (!flags.reasoning) {
      body.include_reasoning = false;
      body.reasoning = { enabled: false, exclude: true };
    }
    maybeNumber(body, "temperature", flags.temperature);
    maybeNumber(body, "max_output_tokens", flags.maxTokens);

    if (flags.stream) {
      const response = await request(options, { method: "POST", path: "/responses", body });
      await streamResponsesResponse(response, options.output === "json");
      return;
    }

    const data = await requestJson<Record<string, unknown>>(options, { method: "POST", path: "/responses", body });
    if (flags.raw || options.output === "json") print(data, options.output);
    else print(extractResponsesText(data), "text");
  });

const exa = program.command("exa").description("Exa search tools through Hack Club AI (closed beta).");

for (const endpoint of ["search", "findSimilar", "contents", "answer"] as const) {
  exa
    .command(endpoint)
    .description(`Proxy Exa /${endpoint}.`)
    .option("--body <json>", "Full Exa request JSON.")
    .option("--body-file <path>", "Read request JSON from a file, or '-' for stdin.")
    .option("--query <text>", "Shortcut for search/answer query.")
    .option("--url <url>", "Shortcut for findSimilar url.")
    .option("--urls <urls>", "Comma-separated URLs for contents.")
    .option("--stream", "Request a streaming response when supported.")
    .action(async (flags: Record<string, unknown>) => {
      const options = getOptions();
      const body = await resolveExaBody(endpoint, flags);
      const data = await requestJson<unknown>(options, {
        method: "POST",
        path: `/exa/${endpoint}`,
        body,
      });
      print(data, options.output);
    });
}

const replicate = program.command("replicate").description("Use Hack Club AI's allowlisted Replicate proxy.");

replicate
  .command("list")
  .description("List Replicate models allowed by Hack Club AI source.")
  .action(async () => {
    const options = getOptions();
    print(flattenReplicate(await fetchReplicateCategories()), options.output);
  });

replicate
  .command("info")
  .description("Fetch Replicate metadata for an allowlisted model.")
  .argument("<model>", "Replicate model ID, e.g. resemble-ai/chatterbox-pro.")
  .action(async (model: string) => {
    const options = getOptions();
    const [owner, name] = splitModelId(model);
    const data = await requestJson<unknown>(options, { path: `/replicate/models/${owner}/${name}` });
    print(data, options.output);
  });

replicate
  .command("run")
  .description("Run an allowlisted Replicate model.")
  .argument("<model>", "Replicate model ID, e.g. resemble-ai/chatterbox-pro.")
  .option("--input <json>", "JSON object to send as Replicate input.")
  .option("--input-file <path>", "Read JSON input from a file, or '-' for stdin.")
  .option("--body <json>", "Full Replicate prediction body. Overrides --input.")
  .option("--body-file <path>", "Read full prediction body from a file, or '-' for stdin.")
  .option("--no-wait", "Do not send Prefer: wait.")
  .option("--out <path>", "Download string URL output to this local path.")
  .action(async (model: string, flags: Record<string, unknown>) => {
    const options = getOptions();
    const [owner, name] = splitModelId(model);
    const body = await resolveReplicateBody(flags);
    const headers: Record<string, string> = {};
    if (flags.wait !== false) headers.Prefer = "wait";
    const data = await requestJson<Record<string, unknown>>(options, {
      method: "POST",
      path: `/replicate/models/${owner}/${name}/predictions`,
      body,
      headers,
    });

    if (typeof flags.out === "string") {
      const url = typeof data.output === "string" ? data.output : undefined;
      if (!url?.startsWith("http")) {
        throw new HcaiError("Replicate output is not a downloadable URL string.", 1, "Use --output json to inspect the raw output shape.");
      }
      await downloadUrl(url, flags.out);
      data.savedTo = flags.out;
    }

    print(data, options.output);
  });

program
  .command("api")
  .description("Raw API escape hatch for new Hack Club AI endpoints.")
  .argument("<path>", "Path under the proxy base URL, e.g. /responses or /ocr.")
  .option("-X, --method <method>", "HTTP method.", "GET")
  .option("--body <json>", "JSON request body.")
  .option("--body-file <path>", "Read JSON body from a file, or '-' for stdin.")
  .option("--no-auth", "Skip Authorization header.")
  .action(async (path: string, flags: Record<string, unknown>) => {
    const options = getOptions();
    const body = await resolveJsonMaybe(flags.body as string | undefined, flags.bodyFile as string | undefined);
    const data = await requestJson<unknown>(options, {
      method: String(flags.method || "GET").toUpperCase(),
      path,
      body,
      auth: flags.auth !== false,
    });
    print(data, options.output);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof HcaiError) {
    process.stderr.write(`hcai: ${error.message}\n`);
    if (error.hint) process.stderr.write(`${error.hint}\n`);
    process.exit(error.exitCode);
  }
  process.stderr.write(`hcai: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});

type ModelListType =
  | "all"
  | "chat"
  | "image"
  | "embedding"
  | "replicate"
  | "text-to-speech"
  | "speech-to-text"
  | "music"
  | "audio"
  | "ocr"
  | "image-utility"
  | "image-upscaling";

async function runSpeechSynthesize(textParts: string[], flags: Record<string, unknown>): Promise<void> {
  const options = getOptions();
  const model = String(flags.model || "minimax/speech-02-turbo");
  const text = await readText(
    (flags.text as string | undefined) || textParts.join(" ") || undefined,
    flags.textFile as string | undefined,
  );

  const input =
    model.startsWith("inworld/")
      ? buildInworldSpeechInput(text, flags)
      : model === "resemble-ai/chatterbox-pro"
        ? buildChatterboxInput(text, flags)
        : buildMinimaxSpeechInput(text, flags);
  Object.assign(input, await resolveJsonMaybe(flags.input as string | undefined, undefined));

  const data = await runReplicateModel(model, { input });
  if (flags.raw) {
    print(data, options.output);
    return;
  }

  const url = extractDownloadableUrl(data);
  if (!url) throw new HcaiError("Speech model did not return a downloadable URL.", 1, "Use --raw --output json to inspect the model response.");
  const out = String(flags.out || defaultOutputPath("speech", String(flags.format || extensionFromUrl(url) || "mp3")));
  await downloadUrl(url, out);
  print(compactPrediction(data, { saved: out, output: url }), options.output);
}

async function runSpeechTranscribe(flags: Record<string, unknown>): Promise<void> {
  const options = getOptions();
  const model = versionedReplicateModel(String(flags.model || "vaibhavs10/incredibly-fast-whisper"));
  const audio = await resolveAudioInput(String(flags.audio));
  const input: Record<string, unknown> =
    model === "nvidia/parakeet-rnnt-1.1b"
      ? { audio_file: audio }
      : {
          audio,
          task: flags.task || "transcribe",
          language: flags.language || "None",
          timestamp: flags.timestamp || "chunk",
        };

  maybeNumber(input, "batch_size", flags.batchSize);
  if (flags.diarize) input.diarise_audio = true;
  if (flags.hfToken) input.hf_token = flags.hfToken;

  const data = await runReplicateModel(model, { input });
  if (flags.raw || options.output === "json") {
    print(data, options.output);
    return;
  }

  const transcript = extractTranscript(data);
  if (typeof flags.out === "string") writeFileSync(flags.out, transcript, "utf8");
  print(transcript || data, "text");
}

async function runMusicGenerate(promptParts: string[], flags: Record<string, unknown>): Promise<void> {
  const options = getOptions();
  const model = String(flags.model || "google/lyria-2");
  const prompt = await readText(
    (flags.prompt as string | undefined) || promptParts.join(" ") || undefined,
    flags.promptFile as string | undefined,
  );
  const input: Record<string, unknown> =
    model === "minimax/music-1.5"
      ? await buildMinimaxMusicInput(prompt, flags)
      : model === "meta/musicgen"
        ? await buildMetaMusicGenInput(prompt, flags)
        : buildLyriaInput(prompt, flags);
  Object.assign(input, await resolveJsonMaybe(flags.input as string | undefined, undefined));

  const data = await runReplicateModel(model, { input });
  if (flags.raw) {
    print(data, options.output);
    return;
  }

  const url = extractDownloadableUrl(data);
  if (!url) throw new HcaiError("Music model did not return a downloadable URL.", 1, "Use --raw --output json to inspect the model response.");
  const out = String(flags.out || defaultOutputPath("music", String(flags.format || extensionFromUrl(url) || "mp3")));
  await downloadUrl(url, out);
  print(compactPrediction(data, { saved: out, output: url }), options.output);
}

function normalizeModelType(type: string): ModelListType {
  const normalized = type.toLowerCase().replace(/_/g, "-");
  const aliases: Record<string, ModelListType> = {
    all: "all",
    chat: "chat",
    text: "chat",
    image: "image",
    images: "image",
    embedding: "embedding",
    embeddings: "embedding",
    replicate: "replicate",
    tts: "text-to-speech",
    "text-to-speech": "text-to-speech",
    speech: "text-to-speech",
    stt: "speech-to-text",
    "speech-to-text": "speech-to-text",
    transcription: "speech-to-text",
    music: "music",
    audio: "audio",
    ocr: "ocr",
    "image-utility": "image-utility",
    "image-utilities": "image-utility",
    utility: "image-utility",
    "image-upscaling": "image-upscaling",
    upscaling: "image-upscaling",
    upscale: "image-upscaling",
  };
  const value = aliases[normalized];
  if (value) return value;
  throw new HcaiError(
    "Invalid model type.",
    2,
    "Use one of: all, chat, image, embedding, replicate, text-to-speech, speech-to-text, music, audio, ocr, image-utility, image-upscaling.",
  );
}

function isReplicateCategoryType(type: ModelListType): boolean {
  return !["all", "chat", "image", "embedding", "replicate"].includes(type);
}

function categoryType(category: string): ModelListType | "replicate" {
  const normalized = category.toLowerCase();
  if (normalized === "text to speech") return "text-to-speech";
  if (normalized === "speech to text") return "speech-to-text";
  if (normalized === "music generation") return "music";
  if (normalized === "audio") return "audio";
  if (normalized === "ocr") return "ocr";
  if (normalized === "image utilities") return "image-utility";
  if (normalized === "image upscaling") return "image-upscaling";
  return "replicate";
}

function modelRow(model: HackClubModel, type: string, details?: boolean): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: model.id,
    type,
    context: model.context_length || "",
    modality: model.architecture?.modality || "",
  };
  if (details) {
    row.name = model.name || "";
    row.parameters = model.supported_parameters?.length || 0;
    row.description = model.description || "";
  }
  return row;
}

function buildInworldSpeechInput(text: string, flags: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {
    text,
    voice_id: flags.voice || "Ashley",
    audio_format: flags.format || "mp3",
  };
  maybeNumber(input, "temperature", flags.temperature);
  maybeNumber(input, "speaking_rate", flags.speed);
  maybeNumber(input, "sample_rate", flags.sampleRate);
  return input;
}

function buildMinimaxSpeechInput(text: string, flags: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {
    text,
    voice_id: flags.voice || "Deep_Voice_Man",
    emotion: flags.emotion || "auto",
    language_boost: flags.language || "English",
    english_normalization: true,
    audio_format: flags.format || "mp3",
    channel: flags.channel || "mono",
  };
  maybeNumber(input, "speed", flags.speed);
  maybeNumber(input, "volume", flags.volume);
  maybeNumber(input, "pitch", flags.pitch);
  maybeNumber(input, "sample_rate", flags.sampleRate);
  maybeNumber(input, "bitrate", flags.bitrate);
  if (flags.subtitles) input.subtitle_enable = true;
  return input;
}

function buildChatterboxInput(text: string, flags: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {
    prompt: text,
    voice: flags.voice || "William (Whispering)",
  };
  maybeNumber(input, "temperature", flags.temperature);
  maybeNumber(input, "exaggeration", flags.exaggeration);
  maybeNumber(input, "seed", flags.seed);
  if (flags.pitch) input.pitch = flags.pitch;
  return input;
}

function buildLyriaInput(prompt: string, flags: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt };
  if (flags.negativePrompt) input.negative_prompt = flags.negativePrompt;
  maybeNumber(input, "seed", flags.seed);
  return input;
}

async function buildMetaMusicGenInput(prompt: string, flags: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input: Record<string, unknown> = { prompt };
  maybeNumber(input, "duration", flags.duration);
  maybeNumber(input, "seed", flags.seed);
  if (flags.format) input.output_format = flags.format;
  if (flags.inputAudio) input.input_audio = await resolveAudioInput(String(flags.inputAudio));
  if (flags.continuation) input.continuation = true;
  return input;
}

async function buildMinimaxMusicInput(prompt: string, flags: Record<string, unknown>): Promise<Record<string, unknown>> {
  const lyrics = await readText(flags.lyrics as string | undefined, flags.lyricsFile as string | undefined).catch(() => "");
  if (!lyrics.trim()) {
    throw new HcaiError("minimax/music-1.5 requires lyrics.", 2, "Pass --lyrics, --lyrics-file, or use the default google/lyria-2 model for prompt-only music.");
  }
  const input: Record<string, unknown> = {
    prompt,
    lyrics,
    audio_format: flags.format || "mp3",
  };
  maybeNumber(input, "sample_rate", flags.sampleRate);
  maybeNumber(input, "bitrate", flags.bitrate);
  return input;
}

async function runReplicateModel(model: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const options = getOptions();
  const [owner, name] = splitModelId(versionedReplicateModel(model));
  return requestJson<Record<string, unknown>>(options, {
    method: "POST",
    path: `/replicate/models/${owner}/${name}/predictions`,
    body,
    headers: { Prefer: "wait" },
  });
}

function versionedReplicateModel(model: string): string {
  const versions: Record<string, string> = {
    "vaibhavs10/incredibly-fast-whisper": "3ab86df6c8f54c11309d4d1f930ac292bad43ace52d10c80d87eb258b3c9f79c",
    "nvidia/parakeet-rnnt-1.1b": "73ddbebaef172a47c8dfdd79381f110bfdc7691bcc7a4edde82f0a39e380ce50",
    "meta/musicgen": "671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb",
  };
  if (model.includes(":")) return model;
  return versions[model] ? `${model}:${versions[model]}` : model;
}

async function resolveAudioInput(value: string): Promise<string> {
  if (/^https?:\/\//i.test(value)) return value;
  const uploaded = await uploadReplicateFile(value);
  return uploaded.url;
}

async function uploadReplicateFile(path: string): Promise<{ url: string; id?: string }> {
  const options = getOptions();
  const form = new FormData();
  const bytes = readFileSync(path);
  form.append("content", new Blob([bytes]), basename(path));
  const response = await requestForm<Record<string, unknown>>(options, "/replicate/files", form);
  const url =
    stringAt(response, "url") ||
    stringAt(response, "urls.get") ||
    stringAt(response, "urls.download") ||
    stringAt(response, "urls.content");
  if (!url) {
    throw new HcaiError("File uploaded, but no URL was returned by Replicate.", 1, JSON.stringify(response, null, 2));
  }
  return { url, id: stringAt(response, "id") };
}

function extractDownloadableUrl(data: Record<string, unknown>): string | undefined {
  const output = data.output;
  if (typeof output === "string" && /^https?:\/\//i.test(output)) return output;
  if (Array.isArray(output)) {
    const found = output.find((item) => typeof item === "string" && /^https?:\/\//i.test(item));
    if (typeof found === "string") return found;
  }
  if (output && typeof output === "object") {
    const direct = stringAt(output as Record<string, unknown>, "url") || stringAt(output as Record<string, unknown>, "audio") || stringAt(output as Record<string, unknown>, "audio_url");
    if (direct && /^https?:\/\//i.test(direct)) return direct;
  }
  return undefined;
}

function compactPrediction(data: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: data.id,
    status: data.status,
    model: data.model,
    error: data.error,
    ...extra,
  };
}

function extractTranscript(data: Record<string, unknown>): string {
  const output = data.output;
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const object = output as Record<string, unknown>;
    for (const key of ["text", "transcription", "transcript", "segments"]) {
      const value = object[key];
      if (typeof value === "string") return value;
    }
    if (Array.isArray(object.chunks)) {
      return object.chunks
        .map((chunk) => (chunk && typeof chunk === "object" ? (chunk as Record<string, unknown>).text : ""))
        .filter(Boolean)
        .join(" ");
    }
  }
  return JSON.stringify(data, null, 2);
}

function defaultOutputPath(prefix: string, extension: string): string {
  return `${prefix}_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.${extension.replace(/^\./, "")}`;
}

function extensionFromUrl(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.match(/\.([a-z0-9]+)$/i)?.[1];
    return ext?.toLowerCase();
  } catch {
    return undefined;
  }
}

function stringAt(object: Record<string, unknown>, path: string): string | undefined {
  let current: unknown = object;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

function splitModelId(model: string): [string, string] {
  const [owner, name] = model.split("/");
  if (!owner || !name) throw new HcaiError(`Invalid model ID: ${model}`, 2, "Expected owner/model.");
  return [owner, name];
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function maybeNumber(body: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) return;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new HcaiError(`${key} must be a number.`, 2);
  body[key] = number;
}

function extractAssistantText(data: Record<string, unknown>): string {
  const choices = data.choices as Array<{ message?: { content?: unknown } }> | undefined;
  const content = choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  return JSON.stringify(data, null, 2);
}

function extractImages(data: Record<string, unknown>): {
  content: string;
  images: Array<{ url: string }>;
} {
  const choices = data.choices as Array<{
    message?: {
      content?: unknown;
      images?: Array<{ image_url?: { url?: string } }>;
    };
  }> | undefined;
  const message = choices?.[0]?.message;
  const images =
    message?.images
      ?.map((image) => image.image_url?.url)
      .filter((url): url is string => Boolean(url))
      .map((url) => ({ url })) || [];
  return {
    content: typeof message?.content === "string" ? message.content : "",
    images,
  };
}

function saveExtractedImages(
  images: Array<{ url: string }>,
  options: { out?: string; outDir: string; outPrefix: string },
): string[] {
  const saved: string[] = [];
  for (let index = 0; index < images.length; index++) {
    const image = images[index];
    if (!image?.url.startsWith("data:")) continue;
    const path =
      index === 0 && options.out
        ? options.out
        : join(
            options.outDir,
            `${options.outPrefix}_${String(index + 1).padStart(3, "0")}.${dataUrlExtension(image.url)}`,
          );
    writeBinaryDataUrl(image.url, path);
    saved.push(path);
  }
  return saved;
}

function extractResponsesText(data: Record<string, unknown>): string {
  const output = data.output;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const text = output
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const object = item as Record<string, unknown>;
        if (typeof object.text === "string") return object.text;
        if (Array.isArray(object.content)) {
          return object.content
            .map((part) => (part && typeof part === "object" ? (part as Record<string, unknown>).text : ""))
            .filter(Boolean)
            .join("");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  if (typeof data.output_text === "string") return data.output_text;
  return JSON.stringify(data, null, 2);
}

async function resolveOcrBody(flags: Record<string, unknown>): Promise<Record<string, unknown>> {
  const full = await resolveJsonMaybe(flags.body as string | undefined, flags.bodyFile as string | undefined);
  if (full && typeof full === "object" && !Array.isArray(full)) return full as Record<string, unknown>;

  const document =
    typeof flags.imageUrl === "string"
      ? { type: "image_url", image_url: flags.imageUrl }
      : typeof flags.documentUrl === "string"
        ? { type: "document_url", document_url: flags.documentUrl }
        : typeof flags.fileId === "string"
          ? { type: "file", file_id: flags.fileId }
          : undefined;
  if (!document) {
    throw new HcaiError(
      "OCR requires a document source.",
      2,
      "Pass --image-url, --document-url, --file-id, or --body with a full OCR request.",
    );
  }

  const body: Record<string, unknown> = {
    model: flags.model || "mistral-ocr-latest",
    document,
    table_format: flags.tableFormat || "markdown",
  };
  if (flags.includeImageBase64) body.include_image_base64 = true;
  if (typeof flags.pages === "string") {
    body.pages = flags.pages
      .split(",")
      .map((page) => Number(page.trim()))
      .filter((page) => Number.isFinite(page));
  }
  return body;
}

async function resolveExaBody(endpoint: string, flags: Record<string, unknown>): Promise<Record<string, unknown>> {
  const full = await resolveJsonMaybe(flags.body as string | undefined, flags.bodyFile as string | undefined);
  if (full && typeof full === "object" && !Array.isArray(full)) return full as Record<string, unknown>;

  const body: Record<string, unknown> = {};
  if (flags.stream) body.stream = true;
  if (typeof flags.query === "string") {
    if (endpoint === "answer") body.query = flags.query;
    else body.query = flags.query;
  }
  if (typeof flags.url === "string" && endpoint === "findSimilar") body.url = flags.url;
  if (typeof flags.urls === "string" && endpoint === "contents") {
    body.urls = flags.urls.split(",").map((url) => url.trim()).filter(Boolean);
  }
  if (Object.keys(body).length === 0) {
    throw new HcaiError(
      `Exa ${endpoint} requires a request body.`,
      2,
      "Pass --body, --body-file, or shortcut flags like --query or --url.",
    );
  }
  return body;
}

async function streamResponsesResponse(response: Response, asJson: boolean): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  const chunks: unknown[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        chunks.push(parsed);
        if (!asJson) {
          const delta =
            (typeof parsed.delta === "string" ? parsed.delta : undefined) ||
            (parsed.delta && typeof parsed.delta === "object"
              ? (parsed.delta as Record<string, unknown>).text
              : undefined);
          if (typeof delta === "string") process.stdout.write(delta);
        }
      } catch {
        // Ignore malformed event fragments.
      }
    }
  }
  if (asJson) process.stdout.write(`${JSON.stringify(chunks, null, 2)}\n`);
  else process.stdout.write("\n");
}

async function streamChatResponse(response: Response, asJson: boolean): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  const chunks: unknown[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const parsed = JSON.parse(raw) as { choices?: Array<{ delta?: { content?: string } }> };
        chunks.push(parsed);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (!asJson && delta) process.stdout.write(delta);
      } catch {
        // Ignore malformed event fragments.
      }
    }
  }
  if (asJson) process.stdout.write(`${JSON.stringify(chunks, null, 2)}\n`);
  else process.stdout.write("\n");
}

async function resolveReplicateBody(flags: Record<string, unknown>): Promise<Record<string, unknown>> {
  const full = await resolveJsonMaybe(flags.body as string | undefined, flags.bodyFile as string | undefined);
  if (full && typeof full === "object" && !Array.isArray(full)) return full as Record<string, unknown>;

  const input = await resolveJsonMaybe(flags.input as string | undefined, flags.inputFile as string | undefined);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HcaiError("Replicate input must be a JSON object.", 2, "Example: hcai replicate run resemble-ai/chatterbox-pro --input '{\"prompt\":\"hello\",\"voice\":\"William (Whispering)\"}'");
  }
  return { input };
}

async function resolveJsonMaybe(json?: string, file?: string): Promise<unknown | undefined> {
  if (!json && !file) return undefined;
  const text = file ? await readText(undefined, file) : json || "";
  try {
    return JSON.parse(text);
  } catch (error) {
    const label = file ? basename(file) : "inline JSON";
    throw new HcaiError(`Invalid JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
}
