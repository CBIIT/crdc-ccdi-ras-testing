import path from "node:path";
import { fileURLToPath } from "node:url";
import { applySettingsToProcess, loadSettings, parseArgs, parseStepArray, printUsage } from "./config.mjs";
import { WorkflowLogger } from "./logger.mjs";
import { getStep } from "./steps.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help === "true" || options.help === true) {
    printUsage();
    process.exit(0);
  }

  const testCaseName = options["test-case"] || "workflow-run";
  const selectedSteps = parseStepArray(options.steps);
  const loadedSettings = loadSettings({
    systemSettings: options["system-settings"],
    userSettings: options["user-settings"],
    cwd: process.cwd(),
  });
  applySettingsToProcess(loadedSettings.merged);

  const defaultRunFolderName = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const runDir = options["run-dir"]
    ? path.resolve(process.cwd(), options["run-dir"])
    : path.join(rootDir, "test-results", defaultRunFolderName);
  const outputDir = path.join(runDir, "workflow-logs");
  const screenshotDir = path.join(runDir, "screenshots");

  const logger = new WorkflowLogger({ testCaseName, outputDir });
  const context = {
    rootDir,
    runDir,
    outputDir,
    screenshotDir,
    selectedSteps,
    testCaseName,
    settings: loadedSettings.merged,
    settingsFiles: loadedSettings.files,
    data: {},
    logger,
  };

  logger.info("Workflow run started", {
    testCaseName,
    selectedSteps,
    runDir,
    outputDir,
    screenshotDir,
    settingsFiles: loadedSettings.files,
  });

  const executedSteps = [];
  try {
    for (const stepId of selectedSteps) {
      const step = getStep(stepId);
      const startedAt = Date.now();
      logger.stepStart(step, { contextKeys: Object.keys(context.data).sort() });
      const result = await step.run(context);
      const durationMs = Date.now() - startedAt;
      executedSteps.push({ id: step.id, name: step.name, durationMs, result });
      logger.stepEnd(step, { durationMs, result });
    }

    const artifacts = logger.export(context, {
      status: "passed",
      executedSteps,
    });
    console.log(JSON.stringify({
      status: "passed",
      testCaseName,
      runDir,
      outputDir,
      screenshotDir,
      executedSteps,
      artifacts,
    }, null, 2));
  } catch (error) {
    logger.error("Workflow run failed", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      contextKeys: Object.keys(context.data).sort(),
    });
    const artifacts = logger.export(context, {
      status: "failed",
      failedStepCount: executedSteps.length,
      executedSteps,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(JSON.stringify({
      status: "failed",
      testCaseName,
      runDir,
      outputDir,
      screenshotDir,
      executedSteps,
      artifacts,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    process.exitCode = 1;
  }
}

main();
