# hcai-cli

Agent-friendly CLI for [Hack Club AI](https://ai.hackclub.com/) and its allowlisted Replicate proxy.

It is built for coding agents as much as humans:

- `--help` on every command
- `--output json` for machine-readable results
- stdin and file inputs
- no required interactive prompts
- local API key config, plus environment variable support
- live model discovery from Hack Club AI endpoints
- Replicate allowlist discovery from the open-source `hackclub/ai` repo, with a bundled fallback

## Install

From this folder:

```bash
npm install
npm run build
npm link
```

`npm link` makes `hcai` available globally on this machine.

## Auth

The CLI checks credentials in this order:

1. `--api-key`
2. `HCAI_API_KEY`
3. `HACKCLUB_AI_API_KEY`
4. `HACK_CLUB_AI_KEY`
5. `REPLICATE_API_TOKEN`
6. `~/.hcai/config.json`

Save a key:

```bash
hcai auth login --api-key sk-hc-v1-...
hcai auth status
```

## Models

```bash
hcai models list
hcai models list --type chat
hcai models list --type image
hcai models list --type embedding
hcai models list --type replicate
hcai models list --type text-to-speech
hcai models list --type speech-to-text
hcai models list --type music
hcai models list --type audio
hcai models list --type ocr
hcai models list --type image-utility
hcai models list --type image-upscaling
hcai models list --type replicate --output json
hcai models info google/gemini-3.8-flash --output json
hcai models info --replicate resemble-ai/chatterbox-pro --output json
```

Regular chat/image/embedding models are fetched from Hack Club AI at runtime. Replicate models are read from Hack Club's open-source allowlist.

## Chat

```bash
hcai chat "Write a tiny haiku about ship logs"
hcai chat --model moonshotai/kimi-k2.6 --system "Be concise" "Explain pgvector"
cat prompt.txt | hcai chat --model google/gemini-3.8-flash
hcai chat "Return JSON only" --output json
hcai responses "Summarize this in one sentence" --system "Be concise"
```

Chat defaults to `google/gemini-3.8-flash`.

By default, chat requests ask OpenRouter to exclude/disable reasoning where supported, because agents usually want the answer rather than hidden thinking payloads. Reasoning-only endpoints (including `google/gemini-3.8-flash`) reject that and return `Reasoning is mandatory for this endpoint and cannot be disabled`. The CLI handles this for you: it retries with reasoning left on but kept out of the printed output, so those models just work. Pass `--reasoning` when you actually want the thinking tokens:

```bash
hcai chat --model openai/gpt-oss-120b --reasoning "Solve this carefully: ..."
```

## Images

```bash
hcai image "A small red robot reading under a desk lamp" --aspect-ratio 1:1
hcai image "A small red robot reading under a desk lamp" --aspect-ratio 1:1 --out robot.png
hcai image "A cinematic wide shot of Istanbul at dawn" --aspect-ratio 16:9 --output json
```

Image generation defaults to `google/gemini-3.1-flash-image`; use `--model google/gemini-3-pro-image` for higher quality.

Image generation uses Hack Club AI's image-capable chat models. Hack Club returns base64 data URLs, so the CLI decodes and saves images by default instead of printing a huge string. Without `--out`, files are written to the current directory as `image_001.png`, `image_002.png`, etc. Use `--raw` if you need the original API response.

## Embeddings

```bash
hcai embed "semantic search text" --output json
cat document.txt | hcai embed --model openai/text-embedding-3-large  # override the google/gemini-embedding-2 default
```

## Speech

Text-to-speech defaults to `minimax/speech-2.8-turbo` (~$0.04/request; use `minimax/speech-02-turbo` for the ~$0.0045 older generation) and saves audio instead of dumping binary or URLs:

```bash
hcai speech synthesize "Hello from Hack Club AI" --out hello.mp3
hcai speech synthesize "Cheaper MiniMax voice" --model minimax/speech-02-turbo --out hello.mp3
hcai tts "Inworld preset voice" --model inworld/tts-1.5-mini --voice Ashley --out hello.mp3
hcai tts "Short alias for speech synthesize" --output json
cat script.txt | hcai speech synthesize --voice Deep_Voice_Man --emotion happy
```

Speech-to-text defaults to `vaibhavs10/incredibly-fast-whisper`. The CLI accepts either remote URLs or local files; local files are uploaded through Hack Club's Replicate file endpoint first.

```bash
hcai speech transcribe --audio meeting.mp3
hcai stt --audio https://example.com/audio.wav --output json
hcai speech transcribe --audio call.mp3 --out transcript.txt
```

The bare STT model slugs currently need versioned Replicate calls under the hood, so the wrapper handles that automatically.

## Music

Music generation defaults to `google/lyria-2` for prompt-only music. For shorter test clips or melody conditioning, `meta/musicgen` is also wrapped.

```bash
hcai music generate "warm ambient piano loop" --out loop.mp3
hcai music generate "soft one second synth tone" --model meta/musicgen --duration 1 --out tone.wav
hcai music generate --model minimax/music-1.5 \
  --prompt "upbeat pop with bright synths" \
  --lyrics "[verse]\nhello hello\n[chorus]\nwe are online" \
  --out song.mp3
```

## Replicate

```bash
hcai replicate list
hcai replicate info minimax/speech-02-turbo --output json
hcai replicate run minimax/speech-02-turbo \
  --input '{"text":"Hello from Hack Club AI CLI.","emotion":"happy","voice_id":"Deep_Voice_Man","language_boost":"English","english_normalization":true}' \
  --output json
```

Download URL outputs directly:

```bash
hcai replicate run minimax/speech-02-turbo \
  --input '{"text":"Saved audio","voice_id":"Deep_Voice_Man"}' \
  --out speech.mp3
```

For models with more complex bodies, pass the full Replicate prediction body:

```bash
hcai replicate run resemble-ai/chatterbox-pro \
  --body '{"input":{"voice":"William (Whispering)","prompt":"Hello"}}'
```

## OCR, Moderation, and Exa

These are first-class commands now. OCR and Exa are still closed beta on Hack Club AI, so you may get a 403 until access is enabled.

```bash
hcai ocr --image-url https://example.com/page.png --output json
hcai moderate "Check this user message for policy issues" --output json
hcai exa search --query "Hack Club AI proxy docs" --output json
hcai exa answer --query "What is pgvector?" --output json
```

## Raw API

Use `api` for endpoints that do not have a wrapper yet:

```bash
hcai api /stats --output json
hcai api /responses -X POST --body '{"model":"google/gemini-3.8-flash","input":"Hello"}' --output json
```

## Notes For Agents

Prefer JSON when scripting:

```bash
hcai models list --type replicate --output json
hcai models list --type text-to-speech --output json
hcai chat "Short answer only: what is 2+2?" --output json
```

Use `--timeout` for long image or Replicate jobs:

```bash
hcai replicate run google/lyria-2 --input-file input.json --timeout 600 --output json
```

Use first-class wrappers (`image`, `tts`, `stt`, `music`) when they fit. Drop down to `replicate run` for specialized models such as voice cloning, sound isolation, background removal, OCR, or upscaling.
