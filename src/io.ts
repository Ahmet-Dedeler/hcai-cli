import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { HcaiError } from "./types.js";

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function readText(value?: string, file?: string): Promise<string> {
  if (file) {
    if (file === "-") return readStdin();
    return readFileSync(file, "utf8");
  }
  if (value !== undefined) return value;
  if (!process.stdin.isTTY) return readStdin();
  throw new HcaiError("No text provided.", 2, "Pass text as an argument, use --file path, or pipe stdin.");
}

export function writeBinaryDataUrl(dataUrl: string, outPath: string): void {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) throw new HcaiError("Image URL is not a data URL; cannot write it as a local file.", 1);
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  const bytes = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  const target = resolve(outPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

export function dataUrlExtension(dataUrl: string): string {
  const mime = dataUrl.match(/^data:([^;,]+)/)?.[1];
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  if (mime === "image/png") return "png";
  return "bin";
}

export async function downloadUrl(url: string, outPath: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new HcaiError(`Download failed with HTTP ${response.status}: ${url}`, 1);
  }
  const target = resolve(outPath);
  mkdirSync(dirname(target), { recursive: true });
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(target, bytes);
}

export function print(value: unknown, output: "text" | "json"): void {
  if (output === "json") {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
    return;
  }
  process.stdout.write(`${formatText(value)}\n`);
}

function formatText(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
      return formatTable(value as Record<string, unknown>[]);
    }
    return value.map((item) => String(item)).join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, val]) => `${key}: ${typeof val === "object" ? JSON.stringify(val) : String(val)}`)
      .join("\n");
  }
  return String(value);
}

function formatTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const widths = keys.map((key) =>
    Math.max(key.length, ...rows.map((row) => String(row[key] ?? "").length)),
  );
  const header = keys.map((key, index) => key.toUpperCase().padEnd(widths[index] || key.length)).join("  ");
  const body = rows
    .map((row) => keys.map((key, index) => String(row[key] ?? "").padEnd(widths[index] || key.length)).join("  "))
    .join("\n");
  return `${header}\n${body}`;
}
