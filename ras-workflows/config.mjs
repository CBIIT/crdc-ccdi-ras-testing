import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseDotEnv(text) {
  const parsed = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function parseSettingsFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  if (path.extname(filePath).toLowerCase() === ".json") {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Settings JSON must contain an object: ${filePath}`);
    }
    return parsed;
  }
  return parseDotEnv(text);
}

export function resolveSettingsFile(input, cwd = process.cwd()) {
  if (!input) throw new Error("A settings file URL or path is required");
  if (input.startsWith("file://")) return fileURLToPath(new URL(input));
  return path.resolve(cwd, input);
}

export function loadSettings({ systemSettings, userSettings, cwd = process.cwd() }) {
  const systemFile = resolveSettingsFile(systemSettings, cwd);
  const userFile = resolveSettingsFile(userSettings, cwd);
  if (!fs.existsSync(systemFile)) throw new Error(`System settings file not found: ${systemFile}`);
  if (!fs.existsSync(userFile)) throw new Error(`User settings file not found: ${userFile}`);

  const systemValues = parseSettingsFile(systemFile);
  const userValues = parseSettingsFile(userFile);
  const merged = { ...systemValues, ...userValues };

  return {
    merged,
    files: {
      system: systemFile,
      user: userFile,
    },
    sources: {
      system: systemValues,
      user: userValues,
    },
  };
}

export function applySettingsToProcess(settings, { override = true } = {}) {
  for (const [key, value] of Object.entries(settings || {})) {
    if (value === undefined || value === null) continue;
    if (!override && process.env[key] !== undefined) continue;
    process.env[key] = String(value);
  }
}

export function parseStepArray(input) {
  if (Array.isArray(input)) return input.map((value) => normalizeStep(value));
  const raw = String(input || "").trim();
  if (!raw) throw new Error("The --steps argument is required");

  let values;
  if (raw.startsWith("[")) values = JSON.parse(raw);
  else values = raw.split(",").map((value) => value.trim()).filter(Boolean);

  if (!Array.isArray(values) || values.length === 0) throw new Error("The step array must contain at least one step id");
  return values.map((value) => normalizeStep(value));
}

function normalizeStep(value) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isInteger(number) || number < 1) throw new Error(`Invalid step id: ${value}`);
  return number;
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = "true";
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

export function printUsage() {
  console.log(`Usage:\n  node ras-workflows/index.mjs --steps 2,3,4 --system-settings file:///abs/system.env --user-settings file:///abs/user.env --test-case CTDC-Auth\n\nOptions:\n  --steps             Comma-separated ids or a JSON array, for example 2,3,4 or [2,3,4]\n  --system-settings   File URL or path for shared system settings\n  --user-settings     File URL or path for user-specific settings\n  --test-case         Logical test case name used in exported log file names\n  --run-dir           Optional run folder. Runner writes to <run-dir>/workflow-logs and <run-dir>/screenshots\n  --help              Print this help text\n`);
}
