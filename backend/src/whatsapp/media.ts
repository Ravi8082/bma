/**
 * Media fetch with SSRF protection.
 *
 * Only Meta domains are allowed. DNS is resolved and private/loopback/link-local
 * addresses are rejected. Redirects are disallowed (or re-validated on each hop).
 * Size and type limits enforced. Magic-byte check prevents extension spoofing.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const ALLOWED_META_HOSTS = [
  "graph.facebook.com",
  "lookaside.fbsbx.com",
];

const MAX_SIZE_BYTES: Record<string, number> = {
  audio: 16 * 1024 * 1024,
  image: 5 * 1024 * 1024,
  document: 16 * 1024 * 1024,
  video: 16 * 1024 * 1024,
};

const ALLOWED_MIME_TYPES: Record<string, string[]> = {
  audio: ["audio/ogg", "audio/mpeg", "audio/wav", "audio/mp4"],
  image: ["image/jpeg", "image/png", "image/webp"],
  document: ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  video: ["video/mp4", "video/3gpp"],
};

const MAGIC_BYTES: Record<string, { offset: number; bytes: number[] }> = {
  "image/jpeg": { offset: 0, bytes: [0xff, 0xd8, 0xff] },
  "image/png": { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] },
  "image/webp": { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
  "application/pdf": { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] },
  "audio/ogg": { offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53] },
  "audio/wav": { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
  "audio/mp4": { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
};

export class MediaFetchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MediaFetchError";
    this.code = code;
  }
}

function isPrivateIP(ip: string): boolean {
  if (isIP(ip) === 4) {
    const parts = ip.split(".").map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 0) return true;
    return false;
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fe80:")) return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("::ffff:127.")) return true;
    return false;
  }
  return true; // unknown format → reject
}

export async function validateMediaUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MediaFetchError("MEDIA_INVALID_URL", "invalid media URL");
  }

  if (parsed.protocol !== "https:") {
    throw new MediaFetchError("MEDIA_INVALID_URL", "media URL must use HTTPS");
  }

  if (!ALLOWED_META_HOSTS.some((host) => parsed.hostname === host)) {
    throw new MediaFetchError("MEDIA_SSRF_BLOCKED", "media URL must point to an allowed Meta domain");
  }

  // Resolve DNS and reject private/loopback/link-local addresses
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(parsed.hostname, { all: true });
  } catch {
    throw new MediaFetchError("MEDIA_DNS_FAILED", "could not resolve media URL hostname");
  }

  if (addresses.length === 0) {
    throw new MediaFetchError("MEDIA_DNS_FAILED", "no addresses resolved for hostname");
  }

  for (const addr of addresses) {
    if (isPrivateIP(addr.address)) {
      throw new MediaFetchError("MEDIA_SSRF_BLOCKED", `resolved address ${addr.address} is private or internal`);
    }
  }
}

export function validateMediaSize(sizeBytes: number, mediaType: string): void {
  const limit = MAX_SIZE_BYTES[mediaType];
  if (limit === undefined) {
    throw new MediaFetchError("MEDIA_UNSUPPORTED_TYPE", `unknown media type: ${mediaType}`);
  }
  if (sizeBytes > limit) {
    throw new MediaFetchError("MEDIA_TOO_LARGE", `media exceeds ${limit} bytes`);
  }
  if (sizeBytes <= 0) {
    throw new MediaFetchError("MEDIA_TOO_LARGE", "media size must be positive");
  }
}

export function validateMimeType(mimeType: string, mediaType: string): void {
  const allowed = ALLOWED_MIME_TYPES[mediaType];
  if (!allowed || !allowed.includes(mimeType)) {
    throw new MediaFetchError("MEDIA_UNSUPPORTED_TYPE", `unsupported MIME type: ${mimeType} for ${mediaType}`);
  }
}

export function validateMagicBytes(buffer: Buffer, mimeType: string): void {
  if (mimeType === "audio/mpeg") {
    if (buffer.length < 3) {
      throw new MediaFetchError("MEDIA_MAGIC_MISMATCH", "file too short for magic-byte check");
    }
    const isId3 = buffer.length >= 3 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33;
    const isSync = buffer.length >= 2 && buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0;
    if (!isId3 && !isSync) {
      throw new MediaFetchError("MEDIA_MAGIC_MISMATCH", "file magic bytes do not match declared MIME type");
    }
    return;
  }
  const spec = MAGIC_BYTES[mimeType];
  if (!spec) return;
  if (buffer.length < spec.offset + spec.bytes.length) {
    throw new MediaFetchError("MEDIA_MAGIC_MISMATCH", "file too short for magic-byte check");
  }
  for (let i = 0; i < spec.bytes.length; i++) {
    if (buffer[spec.offset + i] !== spec.bytes[i]) {
      throw new MediaFetchError("MEDIA_MAGIC_MISMATCH", "file magic bytes do not match declared MIME type");
    }
  }
}

/**
 * Fetch media from a Meta URL with SSRF protection.
 * Redirects are disallowed (redirect: "error").
 */
/**
 * Resolve a WhatsApp media id to a downloadable URL using the Graph API.
 * Returns the URL string. Caller must still validate and fetch via fetchMedia.
 */
export async function resolveWhatsAppMediaUrl(mediaId: string, accessToken: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new MediaFetchError("MEDIA_TIMEOUT", "media metadata request timed out");
    }
    throw new MediaFetchError("MEDIA_FETCH_FAILED", error instanceof Error ? error.message : String(error));
  }
  clearTimeout(timeoutId);
  if (!response.ok) {
    throw new MediaFetchError("MEDIA_FETCH_FAILED", `media metadata HTTP ${response.status}`);
  }
  const data = (await response.json()) as { url?: string };
  if (!data.url) throw new MediaFetchError("MEDIA_FETCH_FAILED", "media metadata missing url");
  return data.url;
}

export async function fetchMedia(
  url: string,
  accessToken: string,
  mediaType: string,
): Promise<{ buffer: Buffer; mimeType: string; size: number }> {
  await validateMediaUrl(url);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new MediaFetchError("MEDIA_TIMEOUT", "media fetch timed out");
    }
    throw new MediaFetchError("MEDIA_FETCH_FAILED", error instanceof Error ? error.message : String(error));
  }

  if (!response.ok) {
    clearTimeout(timeoutId);
    throw new MediaFetchError("MEDIA_FETCH_FAILED", `HTTP ${response.status}`);
  }

  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  validateMimeType(mimeType, mediaType);

  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared <= 0) {
      clearTimeout(timeoutId);
      throw new MediaFetchError("MEDIA_TOO_LARGE", "invalid content-length");
    }
    validateMediaSize(declared, mediaType);
  }

  const limit = MAX_SIZE_BYTES[mediaType] as number;
  const reader = response.body?.getReader();
  if (!reader) {
    clearTimeout(timeoutId);
    throw new MediaFetchError("MEDIA_FETCH_FAILED", "no response body");
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new MediaFetchError("MEDIA_TOO_LARGE", `media exceeds ${limit} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof MediaFetchError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new MediaFetchError("MEDIA_TIMEOUT", "media fetch timed out");
    }
    throw new MediaFetchError("MEDIA_FETCH_FAILED", error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeoutId);
  }

  const buffer = Buffer.concat(chunks);
  validateMediaSize(buffer.length, mediaType);
  validateMagicBytes(buffer, mimeType);
  return { buffer, mimeType, size: buffer.length };
}
