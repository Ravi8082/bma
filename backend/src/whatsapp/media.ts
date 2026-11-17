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

const MAGIC_BYTES: Record<string, number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/webp": [0x52, 0x49, 0x46, 0x46],
  "application/pdf": [0x25, 0x50, 0x44, 0x46],
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
  const expected = MAGIC_BYTES[mimeType];
  if (!expected) return;
  if (buffer.length < expected.length) {
    throw new MediaFetchError("MEDIA_MAGIC_MISMATCH", "file too short for magic-byte check");
  }
  for (let i = 0; i < expected.length; i++) {
    if (buffer[i] !== expected[i]) {
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
  const response = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(mediaId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
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

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: "error", // disallow redirects
  });

  if (!response.ok) {
    throw new MediaFetchError("MEDIA_FETCH_FAILED", `HTTP ${response.status}`);
  }

  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  validateMimeType(mimeType, mediaType);

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  validateMediaSize(buffer.length, mediaType);
  validateMagicBytes(buffer, mimeType);

  return { buffer, mimeType, size: buffer.length };
}
