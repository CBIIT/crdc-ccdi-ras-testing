import fs from "node:fs";
import path from "node:path";

function isSecretKey(key) {
  return /(secret|token|password|code|passport|authorization)/i.test(String(key || ""));
}

function maskString(value) {
  const text = String(value || "");
  if (text.length <= 8) return "[REDACTED]";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function sanitize(value, parentKey = "") {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return isSecretKey(parentKey) ? maskString(value) : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, parentKey));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitize(entry, key)]),
    );
  }
  return String(value);
}

function safeFileName(name) {
  return String(name || "workflow-run").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "workflow-run";
}

export class WorkflowLogger {
  constructor({ testCaseName, outputDir }) {
    this.testCaseName = testCaseName;
    this.outputDir = outputDir;
    this.records = [];
  }

  info(message, details = {}) {
    this.records.push({
      level: "info",
      timestamp: new Date().toISOString(),
      message,
      details: sanitize(details),
    });
  }

  error(message, details = {}) {
    this.records.push({
      level: "error",
      timestamp: new Date().toISOString(),
      message,
      details: sanitize(details),
    });
  }

  stepStart(step, details = {}) {
    this.info(`Step ${step.id} started: ${step.name}`, details);
  }

  stepEnd(step, details = {}) {
    this.info(`Step ${step.id} finished: ${step.name}`, details);
  }

  export(context, summary = {}) {
    fs.mkdirSync(this.outputDir, { recursive: true });
    const baseName = safeFileName(this.testCaseName);
    const jsonPath = path.join(this.outputDir, `${baseName}.json`);
    const textPath = path.join(this.outputDir, `${baseName}.log`);

    const payload = {
      summary: sanitize(summary),
      settingsFiles: sanitize(context.settingsFiles),
      selectedSteps: context.selectedSteps,
      exportedAt: new Date().toISOString(),
      context: sanitize(context.data),
      records: this.records,
    };

    fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const lines = this.records.map((record) => {
      const details = Object.keys(record.details || {}).length ? ` ${JSON.stringify(record.details)}` : "";
      return `[${record.timestamp}] ${record.level.toUpperCase()} ${record.message}${details}`;
    });
    fs.writeFileSync(textPath, `${lines.join("\n")}\n`, "utf8");
    return { jsonPath, textPath };
  }
}
