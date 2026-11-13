import { describe, expect, it } from "vitest";
import {
  MediaFetchError,
  validateMagicBytes,
  validateMediaSize,
  validateMediaUrl,
  validateMimeType,
} from "./media";

describe("media fetch SSRF protection", () => {
  it("accepts Meta domains", () => {
    expect(() => validateMediaUrl("https://graph.facebook.com/v18.0/media/123")).not.toThrow();
    expect(() => validateMediaUrl("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123")).not.toThrow();
  });

  it("rejects non-Meta domains", () => {
    expect(() => validateMediaUrl("https://evil.com/steal")).toThrow(MediaFetchError);
    expect(() => validateMediaUrl("https://localhost/admin")).toThrow(MediaFetchError);
    expect(() => validateMediaUrl("https://127.0.0.1/secret")).toThrow(MediaFetchError);
    expect(() => validateMediaUrl("https://169.254.169.254/metadata")).toThrow(MediaFetchError);
    expect(() => validateMediaUrl("file:///etc/passwd")).toThrow(MediaFetchError);
    expect(() => validateMediaUrl("http://graph.facebook.com/v18.0/media/123")).toThrow(MediaFetchError);
  });

  it("enforces size limits", () => {
    expect(() => validateMediaSize(100, "audio")).not.toThrow();
    expect(() => validateMediaSize(17 * 1024 * 1024, "audio")).toThrow(MediaFetchError);
    expect(() => validateMediaSize(0, "audio")).toThrow(MediaFetchError);
    expect(() => validateMediaSize(6 * 1024 * 1024, "image")).toThrow(MediaFetchError);
  });

  it("enforces MIME type limits", () => {
    expect(() => validateMimeType("audio/ogg", "audio")).not.toThrow();
    expect(() => validateMimeType("application/pdf", "audio")).toThrow(MediaFetchError);
    expect(() => validateMimeType("image/jpeg", "image")).not.toThrow();
    expect(() => validateMimeType("text/html", "image")).toThrow(MediaFetchError);
  });

  it("checks magic bytes", () => {
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(() => validateMagicBytes(jpegBuffer, "image/jpeg")).not.toThrow();

    const fakeJpeg = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x00]);
    expect(() => validateMagicBytes(fakeJpeg, "image/jpeg")).toThrow(MediaFetchError);
  });
});
