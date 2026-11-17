import { describe, expect, it } from "vitest";
import { MediaFetchError, validateMagicBytes } from "../whatsapp/media";

describe("audio magic-byte validation", () => {
  it("accepts OGG", () => {
    const buf = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00]);
    expect(() => validateMagicBytes(buf, "audio/ogg")).not.toThrow();
  });
  it("rejects OGG mismatch", () => {
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    expect(() => validateMagicBytes(buf, "audio/ogg")).toThrow(MediaFetchError);
  });
  it("accepts MP3 ID3", () => {
    const buf = Buffer.from([0x49, 0x44, 0x33, 0x04]);
    expect(() => validateMagicBytes(buf, "audio/mpeg")).not.toThrow();
  });
  it("accepts MP3 frame sync", () => {
    const buf = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
    expect(() => validateMagicBytes(buf, "audio/mpeg")).not.toThrow();
  });
  it("rejects MP3 mismatch", () => {
    const buf = Buffer.from([0x00, 0x00, 0x00]);
    expect(() => validateMagicBytes(buf, "audio/mpeg")).toThrow(MediaFetchError);
  });
  it("accepts WAV", () => {
    const buf = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00]);
    expect(() => validateMagicBytes(buf, "audio/wav")).not.toThrow();
  });
  it("accepts MP4/M4A (ftyp at offset 4)", () => {
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    expect(() => validateMagicBytes(buf, "audio/mp4")).not.toThrow();
  });
  it("rejects MP4 mismatch", () => {
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00, 0x00]);
    expect(() => validateMagicBytes(buf, "audio/mp4")).toThrow(MediaFetchError);
  });
  it("rejects random binary with audio MIME", () => {
    const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    expect(() => validateMagicBytes(buf, "audio/ogg")).toThrow(MediaFetchError);
    expect(() => validateMagicBytes(buf, "audio/wav")).toThrow(MediaFetchError);
    expect(() => validateMagicBytes(buf, "audio/mp4")).toThrow(MediaFetchError);
  });
});
