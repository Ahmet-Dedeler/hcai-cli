import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ConfigFile, GlobalOptions } from "./types.js";
import { HcaiError } from "./types.js";

/** CLI version, shared by --version and the User-Agent header. */
export const VERSION = "0.4.0";
export const USER_AGENT = `hcai-cli/${VERSION}`;

export const DEFAULT_BASE_URL = "https://ai.hackclub.com/proxy/v1";
const CONFIG_PATH = join(homedir(), ".hcai", "config.json");

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function readConfig(): ConfigFile {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as ConfigFile;
  } catch (error) {
    throw new HcaiError(
      `Could not read config at ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      2,
      "Run `hcai auth logout` to remove a corrupted config, then log in again.",
    );
  }
}

export function writeConfig(config: ConfigFile): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
}

export function removeConfig(): void {
  if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH);
}

export function maskKey(key: string): string {
  if (key.length <= 12) return `${key.slice(0, 4)}...`;
  return `${key.slice(0, 10)}...${key.slice(-6)}`;
}

export function resolveGlobalOptions(raw: {
  apiKey?: string;
  baseUrl?: string;
  output?: "text" | "json";
  timeout?: string | number;
  verbose?: boolean;
}): GlobalOptions {
  const fileConfig = readConfig();
  const envKey =
    process.env.HCAI_API_KEY ||
    process.env.HACKCLUB_AI_API_KEY ||
    process.env.HACK_CLUB_AI_KEY ||
    process.env.REPLICATE_API_TOKEN;

  const timeout =
    typeof raw.timeout === "number" ? raw.timeout : Number(raw.timeout ?? 300);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new HcaiError("Timeout must be a positive number of seconds.", 2);
  }

  return {
    apiKey: raw.apiKey || envKey || fileConfig.apiKey,
    baseUrl: trimTrailingSlash(raw.baseUrl || fileConfig.baseUrl || DEFAULT_BASE_URL),
    output: raw.output || "text",
    timeout,
    verbose: Boolean(raw.verbose),
  };
}

export function requireApiKey(options: GlobalOptions): string {
  if (options.apiKey) return options.apiKey;
  throw new HcaiError(
    "No Hack Club AI API key found.",
    3,
    [
      "Set HCAI_API_KEY or HACKCLUB_AI_API_KEY.",
      "Or run: hcai auth login --api-key sk-hc-v1-...",
      "Or pass: --api-key sk-hc-v1-...",
    ].join("\n"),
  );
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function apiUrl(options: GlobalOptions, path: string): string {
  return `${options.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}
