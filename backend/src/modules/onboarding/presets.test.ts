import { describe, expect, it } from "vitest";
import { loadPresets, findPreset } from "./presets";

describe("presets", () => {
  it("seeds exactly 13 presets including FLOWER_SELLER", () => {
    const presets = loadPresets();
    expect(presets).toHaveLength(13);
    expect(presets.map((p) => p.preset_key)).toContain("FLOWER_SELLER");
  });

  it("has unique preset keys", () => {
    const presets = loadPresets();
    const keys = presets.map((p) => p.preset_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("findPreset returns the right preset", () => {
    const preset = findPreset("FLOWER_SELLER");
    expect(preset).toBeDefined();
    expect(preset?.preset_key).toBe("FLOWER_SELLER");
  });

  it("returns undefined for unknown preset", () => {
    expect(findPreset("NONEXISTENT")).toBeUndefined();
  });
});
