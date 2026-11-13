import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PRESETS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "presets",
);

export interface Preset {
  preset_key: string;
  name: string;
  visible_modules: string[];
  vocabulary_hints: Record<string, string>;
  default_report: string;
  template_set: string;
  units: string[];
}

export function loadPresets(): Preset[] {
  const files = fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith(".json"));
  const presets: Preset[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(PRESETS_DIR, file), "utf8");
    const parsed = JSON.parse(raw) as Preset;
    if (!parsed.preset_key || !/^[A-Z][A-Z0-9_]{2,40}$/.test(parsed.preset_key)) {
      throw new Error(`invalid preset_key in ${file}`);
    }
    presets.push(parsed);
  }
  return presets;
}

export function findPreset(key: string): Preset | undefined {
  return loadPresets().find((p) => p.preset_key === key);
}
