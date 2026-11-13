/**
 * Media fetch with SSRF protection.
 *
 * Only Meta domains are allowed. Size and type limits enforced.
 * Magic-byte check prevents extension spoofing.
 */

const ALLOWED_META_HOSTS = [
  "graph.facebook.com",
  "lookaside.fbsbx.com",
  "scontent.xx.fbcdn.net",
  "scontent-iad3-1.xx.fbcdn.net",
];

const MAX_SIZE_BYTES: Record<string, number> = {
  audio: 16 * 1024 * 1024, // 16 MB
  image: 5 * 1024 * 1024,  // 5 MB
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

export function validateMediaUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MediaFetchError("MEDIA_INVALID_URL", "invalid media URL");
  }

  if (parsed.protocol !== "https:") {
    throw new MediaFetchError("MEDIA_INVALID_URL", "media URL must use HTTPS");
  }

  if (!ALLOWED_META_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) {
    throw new MediaFetchError("MEDIA_SSRF_BLOCKED", "media URL must point to a Meta domain");
  }

  // Block private IP ranges even if hostname resolves to them
  const hostname = parsed.hostname;
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("172.") ||
    hostname === "169.254.169.254" ||
    hostname.startsWith("file:")
  ) {
    throw new MediaFetchError("MEDIA_SSRF_BLOCKED", "media URL must not point to a private or internal address");
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
  if (!expected) return; // no magic bytes defined for this type
  if (buffer.length < expected.length) {
    throw new MediaFetchError("MEDIA_MAGIC_MISMATCH", "file too short for magic-byte check");
  }
  for (let i = 0; i < expected.length; i++) {
    if (buffer[i] !== expected[i]) {
      throw new MediaFetchError("MEDIA_MAGIC_MISMATCH", "file magic bytes do not match declared MIME type");
    }
  }
}
