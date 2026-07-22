#!/usr/bin/env node
/**
 * RAS Test Results Dashboard Generator
 * -------------------------------------
 * Scans `test-results/` for validation reports (preferred) and raw workflow
 * execution logs (fallback), then renders a static two-page HTML dashboard
 * into a timestamped subfolder so each generation run is kept separately:
 *
 *   test-results/dashboard/<run-timestamp>/index.html         - high-level
 *                                             summary (counts, pass/fail, time)
 *   test-results/dashboard/<run-timestamp>/details/<id>.html  - per test case
 *                                             detail page (steps, evidence, screenshots)
 *
 * Usage:
 *   node generate-dashboard.mjs
 *   npm run dashboard:generate
 *
 * Filter to a single test-results run folder (only include results whose
 * run folder matches, instead of every run found under test-results/):
 *   node generate-dashboard.mjs --run 2026-07-16T14-51-03-574Z
 *   node generate-dashboard.mjs --run=2026-07-16T14-51-03-574Z
 *   node generate-dashboard.mjs --latest        (most recent run folder only)
 *
 * The generated index page also includes a client-side "Run" dropdown to
 * interactively filter the table by run folder without regenerating.
 *
 * No external dependencies. Screenshots are referenced in place (not copied),
 * so keep the generated `dashboard/` folder inside `test-results/`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEST_RESULTS_DIR = path.join(ROOT, 'test-results');
const DASHBOARD_ROOT = path.join(TEST_RESULTS_DIR, 'dashboard');

function timestampFolderName(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

// ---------------------------------------------------------------------------
// Generic filesystem helpers
// ---------------------------------------------------------------------------

function walk(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (full === DASHBOARD_ROOT) continue; // never scan previously generated dashboards
    if (entry.isDirectory()) {
      walk(full, fileList);
    } else {
      fileList.push(full);
    }
  }
  return fileList;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`  ! Skipping unreadable JSON: ${path.relative(ROOT, file)} (${err.message})`);
    return null;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slugify(...parts) {
  return parts
    .filter(Boolean)
    .join('__')
    .replace(/[^a-zA-Z0-9_-]+/g, '-');
}

function relFromOutput(outputFile, absTarget) {
  return path.relative(path.dirname(outputFile), absTarget).split(path.sep).join('/');
}

function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

function formatDate(iso) {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escapeHtml(iso);
  return d.toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function formatDurationLong(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)} milliseconds`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} seconds`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

const STEP_NAME_DICTIONARY = {
  'authorize-login': 'Authorize & Login',
  'exchange-authorization-code': 'Exchange Code for Tokens',
  userinfo: 'Get User Info',
};

function prettifyStepName(name) {
  if (!name) return 'Step';
  if (STEP_NAME_DICTIONARY[name]) return STEP_NAME_DICTIONARY[name];
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function prettifyKey(key) {
  const words = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .trim();
  return words
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function isEvidenceOk(value) {
  if (value === false) return false;
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' && /^(fail|error|missing|false)$/i.test(value.trim())) return false;
  return true;
}

function formatEvidenceValue(value) {
  if (value === true) return 'Present';
  if (value === false) return 'Missing';
  if (value === null || value === undefined || value === '') return 'n/a';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function buildEvidenceItemsFromResult(resultObj) {
  return Object.entries(resultObj || {}).map(([key, value]) => ({
    label: prettifyKey(key),
    value: formatEvidenceValue(value),
    ok: isEvidenceOk(value),
  }));
}

const CATEGORY_SECTION_META = {
  Authorization: { title: 'Authorization Step Validation', icon: '\u{1F510}' },
  TokenExchange: { title: 'Token Exchange Validation', icon: '\u{1F511}' },
  UserInfo: { title: 'User Info & IAL2 Validation', icon: '\u{1F464}' },
  IAL2Verification: { title: 'User Info & IAL2 Validation', icon: '\u{1F464}' },
  Screenshots: { title: 'Screenshot Artifacts', icon: '\u{1F4F8}' },
};

function buildEvidenceGroups(evidenceItems) {
  const groups = new Map();
  for (const item of evidenceItems || []) {
    const meta = CATEGORY_SECTION_META[item.category] || { title: item.category || 'Other', icon: '\u{1F4CB}' };
    if (!groups.has(meta.title)) groups.set(meta.title, { title: meta.title, icon: meta.icon, items: [] });
    const status = String(item.status || '').toUpperCase();
    groups.get(meta.title).items.push({
      label: item.check || meta.title,
      value: item.value ?? formatEvidenceValue(item.actual),
      ok: status ? status !== 'FAIL' : isEvidenceOk(item.actual),
    });
  }
  return [...groups.values()];
}

function guessIdp(caseId, explicit) {
  if (explicit) return explicit;
  const lower = String(caseId || '').toLowerCase();
  if (lower.includes('id_me') || lower.includes('idme')) return 'ID.me';
  if (lower.includes('login_gov') || lower.includes('logingov') || lower.includes('login.gov')) return 'Login.gov';
  return null;
}

function verdictClassLower(verdict) {
  switch (verdict) {
    case 'PASS':
      return 'pass';
    case 'FAIL':
      return 'fail';
    case 'PARTIAL':
      return 'partial';
    default:
      return 'unknown';
  }
}

function verdictIcon(verdict) {
  switch (verdict) {
    case 'PASS':
      return '\u2713';
    case 'FAIL':
      return '\u2717';
    case 'PARTIAL':
      return '~';
    default:
      return '?';
  }
}

function verdictLabel(verdict) {
  switch (verdict) {
    case 'PASS':
      return 'PASSED';
    case 'FAIL':
      return 'FAILED';
    case 'PARTIAL':
      return 'PARTIAL';
    default:
      return 'UNKNOWN';
  }
}

function scoreColor(verdict) {
  switch (verdict) {
    case 'PASS':
      return '#4CAF50';
    case 'FAIL':
      return '#f44336';
    case 'PARTIAL':
      return '#ff9800';
    default:
      return '#9e9e9e';
  }
}

function prettifyScreenshotCaption(filePath, caseId) {
  let base = path.basename(filePath, path.extname(filePath));
  base = base.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_/, '');
  if (caseId) {
    base = base.replace(new RegExp(`^${escapeRegExp(caseId)}_`), '');
  }
  base = base.replace(/^\d+-/, '');
  return base
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function findValidationReportFiles() {
  return walk(TEST_RESULTS_DIR).filter((f) => {
    const base = path.basename(f);
    return base.endsWith('-validation-report.json') && !base.startsWith('BATCH');
  });
}

function findRawLogFiles() {
  return walk(TEST_RESULTS_DIR).filter((f) => {
    if (!f.endsWith('.json')) return false;
    return path.basename(path.dirname(f)) === 'workflow-logs';
  });
}

function runFolderFromPath(filePath, anchorDirName) {
  const parts = filePath.split(path.sep);
  const idx = parts.lastIndexOf(anchorDirName);
  if (idx <= 0) return null;
  const parent = parts[idx - 1];
  return parent === 'test-results' ? null : parent;
}

function loadRawLog(executionLogRelPath) {
  if (!executionLogRelPath) return null;
  const abs = path.isAbsolute(executionLogRelPath)
    ? executionLogRelPath
    : path.join(ROOT, executionLogRelPath);
  if (!fs.existsSync(abs)) return null;
  return { abs, json: readJson(abs) };
}

function findScreenshotsForCase(caseId, screenshotsDirAbs, startIso, endIso) {
  if (!screenshotsDirAbs || !fs.existsSync(screenshotsDirAbs)) return [];
  const files = fs.readdirSync(screenshotsDirAbs).filter((f) => /\.(png|jpe?g)$/i.test(f));

  // Modern run folders embed the case id in the filename, e.g.
  // "2026-07-16T14-51-07_yizhen_id_me_login_no_linked_00-ras-login-page.png"
  const caseTagRe = new RegExp(`_${escapeRegExp(caseId)}_\\d`);
  let matched = files.filter((f) => caseTagRe.test(f));

  if (matched.length === 0 && startIso) {
    // Legacy shared screenshot directories have no case id in the filename;
    // fall back to a time-window heuristic around the execution window.
    const start = new Date(startIso).getTime() - 5000;
    const end = (endIso ? new Date(endIso).getTime() : start) + 5000;
    matched = files.filter((f) => {
      const m = f.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
      if (!m) return false;
      const t = new Date(m[1].replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3') + 'Z').getTime();
      return !Number.isNaN(t) && t >= start && t <= end;
    });
  }

  matched.sort();
  return matched.map((f) => path.join(screenshotsDirAbs, f));
}

function buildSteps(rawLog, stepValidations, overallVerdict) {
  const validationById = new Map((stepValidations || []).map((sv) => [sv.stepId, sv]));

  if (rawLog?.json?.summary?.executedSteps?.length) {
    return rawLog.json.summary.executedSteps.map((step) => {
      const sv = validationById.get(step.id);
      return {
        id: step.id,
        name: step.name,
        durationMs: step.durationMs ?? null,
        result: step.result ?? {},
        status: (sv?.status || overallVerdict || 'UNKNOWN').toUpperCase(),
      };
    });
  }

  return (stepValidations || []).map((sv) => ({
    id: sv.stepId,
    name: sv.stepName || `Step ${sv.stepId}`,
    durationMs: sv.duration_ms ?? sv.durationMs ?? null,
    result: sv.evidence || {},
    status: (sv.status || overallVerdict || 'UNKNOWN').toUpperCase(),
  }));
}

function normalizeValidationReport(reportPath) {
  const json = readJson(reportPath);
  if (!json) return null;

  const meta = json.reportMetadata || {};
  const vr = json.validationResults || {};
  const caseId = meta.testCaseId || path.basename(reportPath).replace(/-validation-report\.json$/, '');
  const runFolder = meta.runFolder
    ? path.basename(meta.runFolder)
    : runFolderFromPath(reportPath, 'validation-reports');

  const rawLog = loadRawLog(meta.executionLogPath);
  const verdict = String(vr.verdict || 'UNKNOWN').toUpperCase();
  const score = vr.score ?? null;
  const stepValidations = vr.stepValidations || vr.step_validations || [];
  const steps = buildSteps(rawLog, stepValidations, verdict);

  const execSummary = json.executionSummary || {};
  let executionStart = execSummary.execution_start || null;
  let executionEnd = execSummary.execution_end || null;
  let totalDurationMs = execSummary.total_duration_ms ?? null;

  if ((!executionStart || !executionEnd) && rawLog?.json?.records?.length) {
    const records = rawLog.json.records;
    executionStart = executionStart || records[0].timestamp;
    executionEnd = executionEnd || rawLog.json.exportedAt || records[records.length - 1].timestamp;
  }
  if (totalDurationMs === null) {
    totalDurationMs =
      executionStart && executionEnd
        ? new Date(executionEnd).getTime() - new Date(executionStart).getTime()
        : steps.reduce((sum, s) => sum + (s.durationMs || 0), 0);
  }
  executionStart = executionStart || meta.generatedAt;
  executionEnd = executionEnd || meta.generatedAt;

  let screenshots = [];
  const explicitFiles = vr.screenshotValidation?.files;
  if (Array.isArray(explicitFiles) && explicitFiles.length) {
    screenshots = explicitFiles
      .map((f) => (path.isAbsolute(f) ? f : path.join(ROOT, f)))
      .filter((f) => fs.existsSync(f));
  } else {
    const screenshotsDirRaw = json.summary?.artifactPaths?.screenshots_dir || json.artifacts?.screenshots_directory || null;
    const screenshotsDirAbs = screenshotsDirRaw
      ? (path.isAbsolute(screenshotsDirRaw) ? screenshotsDirRaw : path.join(ROOT, screenshotsDirRaw))
      : null;
    screenshots = findScreenshotsForCase(caseId, screenshotsDirAbs, executionStart, executionEnd);
  }

  const criteriaParsed = json.validationCriteria?.parsed || {};
  const criteriaValidation = Object.values(vr.criteria_validation || {});
  const evidenceItems = vr.evidence_items || [];

  return {
    id: slugify(caseId, runFolder),
    caseId,
    runFolder,
    source: 'validation-report',
    verdict,
    score,
    idp: guessIdp(caseId, meta.idp || json.testCaseMetadata?.idp),
    criteriaRaw: json.validationCriteria?.raw || '',
    criteriaParsedPass: criteriaParsed.pass || [],
    criteriaParsedFail: criteriaParsed.fail || [],
    criteriaValidation,
    evidenceItems,
    evidenceGroups: buildEvidenceGroups(evidenceItems),
    steps,
    totalDurationMs,
    executionStart,
    executionEnd,
    generatedAt: meta.generatedAt || executionEnd,
    screenshots,
    executionLogPath: rawLog?.abs || null,
    textLogPath: rawLog?.abs ? rawLog.abs.replace(/\.json$/, '.log') : null,
  };
}

function normalizeRawLog(logPath, coveredLogPaths) {
  if (coveredLogPaths.has(logPath)) return null;
  const json = readJson(logPath);
  if (!json?.summary) return null;

  const records = json.records || [];
  const caseId = records[0]?.details?.testCaseName || path.basename(logPath, '.json');
  const workflowLogsDir = path.dirname(logPath);
  const runFolder = runFolderFromPath(workflowLogsDir, 'workflow-logs');

  const overallStatus = json.summary.status === 'passed' ? 'PASS' : 'FAIL';
  const steps = (json.summary.executedSteps || []).map((s) => ({
    id: s.id,
    name: s.name,
    durationMs: s.durationMs ?? null,
    result: s.result ?? {},
    status: overallStatus,
  }));

  const executionStart = records[0]?.timestamp || json.exportedAt;
  const executionEnd = json.exportedAt || records[records.length - 1]?.timestamp;
  const totalDurationMs =
    executionStart && executionEnd
      ? new Date(executionEnd).getTime() - new Date(executionStart).getTime()
      : steps.reduce((sum, s) => sum + (s.durationMs || 0), 0);

  const screenshotsDirAbs = path.join(path.dirname(workflowLogsDir), 'screenshots');
  const screenshots = findScreenshotsForCase(caseId, screenshotsDirAbs, executionStart, executionEnd);

  return {
    id: slugify(caseId, runFolder),
    caseId,
    runFolder,
    source: 'raw-log (unvalidated)',
    verdict: overallStatus,
    score: null,
    idp: guessIdp(caseId),
    criteriaRaw: '',
    criteriaParsedPass: [],
    criteriaParsedFail: [],
    criteriaValidation: [],
    evidenceItems: [],
    evidenceGroups: [],
    steps,
    totalDurationMs,
    executionStart,
    executionEnd,
    generatedAt: executionEnd,
    screenshots,
    executionLogPath: logPath,
    textLogPath: logPath.replace(/\.json$/, '.log'),
  };
}

function collectResults() {
  const results = [];
  const coveredLogPaths = new Set();

  for (const reportPath of findValidationReportFiles()) {
    const normalized = normalizeValidationReport(reportPath);
    if (normalized) {
      results.push(normalized);
      if (normalized.executionLogPath) coveredLogPaths.add(normalized.executionLogPath);
    }
  }

  for (const logPath of findRawLogFiles()) {
    const normalized = normalizeRawLog(logPath, coveredLogPaths);
    if (normalized) results.push(normalized);
  }

  results.sort((a, b) => new Date(b.generatedAt || 0) - new Date(a.generatedAt || 0));
  return results;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function verdictBadgeClass(verdict) {
  switch (verdict) {
    case 'PASS':
      return 'badge-pass';
    case 'FAIL':
      return 'badge-fail';
    case 'PARTIAL':
      return 'badge-partial';
    default:
      return 'badge-unknown';
  }
}

function baseStyles() {
  return `
    :root {
      --bg: #f4f5f7;
      --surface: #ffffff;
      --border: #e3e5e8;
      --text: #1f2430;
      --text-muted: #6b7280;
      --accent: #3b5bdb;
      --pass: #16a34a;
      --fail: #dc2626;
      --partial: #d97706;
      --unknown: #6b7280;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: var(--bg);
      padding: 24px; min-height: 100vh; color: var(--text);
    }
    .container { max-width: 1400px; margin: 0 auto; background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); overflow: hidden; }
    header { background: var(--surface); color: var(--text); border-bottom: 1px solid var(--border);
      padding: 28px 32px; text-align: center; }
    header h1 { font-size: 1.7em; font-weight: 600; }
    header .subtitle { opacity: 0.85; font-size: 0.95em; color: var(--text-muted); margin-top: 4px; }
    .content { padding: 30px; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    h2 { color: var(--text); font-size: 1.3em; font-weight: 600; margin: 0 0 16px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .metric-card { background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--accent);
      border-radius: 8px; padding: 16px 18px; }
    .metric-card .value { font-size: 1.7em; font-weight: 600; color: var(--text); }
    .metric-card .label { font-size: 0.78em; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; margin-top: 4px; }
    .metric-card.pass { border-left-color: var(--pass); }
    .metric-card.fail { border-left-color: var(--fail); }
    .metric-card.partial { border-left-color: var(--partial); }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 4px; font-weight: 600; font-size: 0.75em; color: #fff; letter-spacing: 0.02em; }
    .badge-pass { background: var(--pass); }
    .badge-fail { background: var(--fail); }
    .badge-partial { background: var(--partial); }
    .badge-unknown { background: var(--unknown); }
    table { width: 100%; border-collapse: collapse; font-size: 0.94em; }
    thead th { text-align: left; background: var(--bg); color: var(--text-muted); padding: 12px 14px;
      border-bottom: 1px solid var(--border); position: sticky; top: 0; font-weight: 600; z-index: 1; }
    tbody td { padding: 12px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    tbody tr:hover { background: var(--bg); }
    .table-scroll { max-height: 65vh; overflow-y: auto; overflow-x: auto; border: 1px solid var(--border);
      border-radius: 8px; }
    .table-scroll table { border: none; }
    .search-bar { margin-bottom: 16px; }
    .search-bar input { width: 100%; max-width: 360px; padding: 10px 14px; border: 1px solid var(--border);
      border-radius: 8px; font-size: 0.95em; color: var(--text); }
    .search-bar input:focus { outline: none; border-color: var(--accent); }
    .pill { display: inline-block; padding: 2px 10px; border-radius: 4px; background: var(--bg); border: 1px solid var(--border);
      font-size: 0.8em; color: var(--text-muted); }
    .mono { font-family: 'SFMono-Regular', Consolas, Menlo, monospace; font-size: 0.85em; }
    footer { text-align: center; padding: 18px; color: var(--text-muted); font-size: 0.85em; border-top: 1px solid var(--border); }

    /* details page */
    .back-link { display: inline-block; margin-bottom: 20px; font-weight: 600; }
    .verdict-pill { display: inline-block; font-size: 1em; font-weight: 600; padding: 6px 16px; border-radius: 6px;
      margin-top: 10px; color: #fff; }
    .verdict-pill.pass { background: var(--pass); }
    .verdict-pill.fail { background: var(--fail); }
    .verdict-pill.partial { background: var(--partial); }
    .verdict-pill.unknown { background: var(--unknown); }

    .score-wrap { text-align: center; margin-bottom: 10px; }
    .score-circle { width: 130px; height: 130px; border-radius: 50%; border: 5px solid var(--border);
      background: var(--surface); display: flex; flex-direction: column; align-items: center; justify-content: center;
      margin: 0 auto; }
    .score-value { font-size: 2em; font-weight: 700; color: var(--text); }
    .score-label { font-size: 0.78em; color: var(--text-muted); margin-top: 2px; }

    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .stat-box { background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--accent);
      padding: 18px; border-radius: 8px; text-align: center; }
    .stat-value { font-size: 1.8em; font-weight: 600; color: var(--text); margin-bottom: 4px; }
    .stat-label { font-size: 0.78em; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; }

    .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 20px; }
    .meta-item { background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--accent);
      padding: 12px 14px; border-radius: 8px; }
    .meta-item label { display: block; font-size: 0.75em; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px; }
    .meta-item .val { font-weight: 600; color: var(--text); word-break: break-word; }

    .criteria-box { background: var(--bg); border: 1px solid var(--border); border-left: 3px solid var(--accent);
      padding: 15px; margin: 15px 0 28px; border-radius: 6px; white-space: pre-wrap; font-size: 0.95em; }

    .evidence-list { list-style: none; margin: 12px 0 20px; }
    .evidence-item { display: flex; align-items: flex-start; padding: 9px 12px; margin: 6px 0; background: var(--surface);
      border: 1px solid var(--border); border-radius: 6px; }
    .evidence-item.fail { border-color: var(--fail); background: #fef2f2; }
    .evidence-icon { flex: none; width: 18px; text-align: center; margin-right: 10px; font-weight: 700; color: var(--text-muted); }
    .evidence-item.fail .evidence-icon { color: var(--fail); }
    .evidence-text { flex: 1; }
    .evidence-check { font-weight: 600; color: var(--text); display: block; }
    .evidence-value { color: var(--text-muted); font-size: 0.88em; display: block; margin-top: 2px; word-break: break-word; }

    .step-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; margin-bottom: 20px; }
    .step-card { background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--unknown);
      border-radius: 8px; padding: 18px; }
    .step-card.pass { border-left-color: var(--pass); }
    .step-card.fail { border-left-color: var(--fail); }
    .step-card.partial { border-left-color: var(--partial); }
    .step-number { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px;
      background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 50%; font-weight: 600;
      font-size: 0.85em; margin-bottom: 8px; }
    .step-card h3 { color: var(--text); margin-bottom: 6px; border: none; font-size: 1.1em; font-weight: 600; }
    .step-duration-label { color: var(--text-muted); font-size: 0.85em; margin: 6px 0 12px; }
    .step-card .evidence-list { text-align: left; font-size: 0.9em; margin-top: 6px; }
    .step-card details { margin-top: 10px; }
    .step-card summary { cursor: pointer; font-size: 0.8em; color: var(--accent); }
    .step-card pre { background: #282c34; color: #abb2bf; padding: 10px 12px; border-radius: 6px; overflow-x: auto;
      font-size: 0.78em; margin-top: 8px; }

    .evidence-groups h3 { color: var(--text); font-size: 1.05em; font-weight: 600; margin-top: 22px; margin-bottom: 10px;
      display: flex; align-items: center; }
    .evidence-groups h3 .icon { margin-right: 10px; }

    .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 15px; margin-bottom: 10px; }
    .gallery-item { position: relative; aspect-ratio: 16/9; background: var(--bg); border-radius: 8px; overflow: hidden;
      cursor: pointer; transition: transform 0.2s ease, box-shadow 0.2s ease; border: 1px solid var(--border); }
    .gallery-item:hover { transform: translateY(-3px); box-shadow: 0 6px 16px rgba(0,0,0,0.12); }
    .gallery-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .gallery-label { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.65); color: #fff;
      padding: 6px 8px; font-size: 0.78em; text-align: center; }

    .artifact-box { background: var(--bg); border: 1px solid var(--border); border-left: 3px solid var(--accent);
      padding: 18px 20px; border-radius: 8px; margin-bottom: 10px; }

    .conclusion-box { background: var(--bg); border: 1px solid var(--border); border-left: 4px solid var(--unknown);
      padding: 20px; border-radius: 8px; line-height: 1.7; }
    .conclusion-box.pass { border-left-color: var(--pass); }
    .conclusion-box.fail { border-left-color: var(--fail); background: #fef2f2; }
    .conclusion-box.partial { border-left-color: var(--partial); }
    .conclusion-box ul { margin: 12px 0 0 20px; }

    .timestamp-footer { text-align: center; color: var(--text-muted); font-size: 0.85em; padding: 18px; border-top: 1px solid var(--border); }

    .empty-note { color: var(--text-muted); font-style: italic; padding: 10px 0; }
    #lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 999;
      align-items: center; justify-content: center; padding: 40px; }
    #lightbox.open { display: flex; }
    #lightbox img { max-width: 100%; max-height: 100%; border-radius: 6px; box-shadow: 0 0 30px rgba(0,0,0,0.5); }
    #lightbox .hint { position: absolute; top: 20px; right: 30px; color: #fff; font-size: 0.9em; }
  `;
}

function renderIndexPage(results, outputFile, appliedRunFilter) {
  const total = results.length;
  const passed = results.filter((r) => r.verdict === 'PASS').length;
  const failed = results.filter((r) => r.verdict === 'FAIL').length;
  const partial = results.filter((r) => r.verdict === 'PARTIAL').length;
  const passRate = total ? Math.round((passed / total) * 100) : 0;
  const totalDurationMs = results.reduce((sum, r) => sum + (r.totalDurationMs || 0), 0);
  const avgDurationMs = total ? totalDurationMs / total : 0;

  const runFolders = [...new Set(results.map((r) => r.runFolder || '__legacy__'))].sort();
  const runFilterHtml = runFolders.length > 1
    ? `<select id="run-filter">
        <option value="">All Runs</option>
        ${runFolders
          .map(
            (rf) =>
              `<option value="${escapeHtml(rf)}">${rf === '__legacy__' ? 'Legacy (no run folder)' : escapeHtml(rf)}</option>`
          )
          .join('')}
      </select>`
    : '';

  const rows = results
    .map((r) => {
      const stepsPassed = r.steps.filter((s) => s.status === 'PASS').length;
      const runKey = r.runFolder || '__legacy__';
      return `
      <tr data-case="${escapeHtml(r.caseId.toLowerCase())}" data-verdict="${r.verdict}" data-run="${escapeHtml(runKey)}">
        <td><strong>${escapeHtml(r.caseId)}</strong></td>
        <td>${r.runFolder ? `<span class="pill mono">${escapeHtml(r.runFolder)}</span>` : '<span class="pill">legacy</span>'}</td>
        <td><span class="badge ${verdictBadgeClass(r.verdict)}">${escapeHtml(r.verdict)}</span></td>
        <td>${r.score !== null ? `${r.score}%` : 'n/a'}</td>
        <td>${formatDuration(r.totalDurationMs)}</td>
        <td>${stepsPassed}/${r.steps.length} passed</td>
        <td>${r.screenshots.length}</td>
        <td>${formatDate(r.generatedAt)}</td>
        <td><a href="details/${r.id}.html">View details &rarr;</a></td>
      </tr>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RAS Test Results Dashboard</title>
<style>${baseStyles()}</style>
</head>
<body>
  <div class="container">
    <header>
      <h1>RAS OAuth Workflow &mdash; Test Results Dashboard</h1>
      <div class="subtitle">Generated ${escapeHtml(formatDate(new Date().toISOString()))}${appliedRunFilter ? ` &middot; Filtered to run: ${escapeHtml(appliedRunFilter)}` : ''}</div>
    </header>
    <div class="content">
      <section>
        <h2>Summary</h2>
        <div class="metrics">
          <div class="metric-card"><div class="value">${total}</div><div class="label">Test Cases</div></div>
          <div class="metric-card pass"><div class="value">${passed}</div><div class="label">Passed</div></div>
          <div class="metric-card fail"><div class="value">${failed}</div><div class="label">Failed</div></div>
          <div class="metric-card partial"><div class="value">${partial}</div><div class="label">Partial</div></div>
          <div class="metric-card"><div class="value">${passRate}%</div><div class="label">Pass Rate</div></div>
          <div class="metric-card"><div class="value">${formatDuration(totalDurationMs)}</div><div class="label">Total Exec. Time</div></div>
          <div class="metric-card"><div class="value">${formatDuration(avgDurationMs)}</div><div class="label">Avg. Duration</div></div>
        </div>
      </section>
      <section>
        <h2>Test Cases</h2>
        <div class="search-bar">
          <input type="text" id="search" placeholder="Filter by case id..." />
          ${runFilterHtml}
        </div>
        <div class="table-scroll">
          <table id="results-table">
            <thead>
              <tr>
                <th>Case ID</th><th>Run</th><th>Verdict</th><th>Score</th><th>Duration</th><th>Steps</th><th>Screenshots</th><th>Generated</th><th></th>
              </tr>
            </thead>
            <tbody>
              ${rows || '<tr><td colspan="9" class="empty-note">No test results found under test-results/.</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
    </div>
    <footer>RAS Testing &middot; Test Results Dashboard &middot; ${total} test case(s) indexed</footer>
  </div>
  <script>
    const searchInput = document.getElementById('search');
    const runFilter = document.getElementById('run-filter');
    function applyFilters() {
      const q = searchInput.value.trim().toLowerCase();
      const run = runFilter ? runFilter.value : '';
      document.querySelectorAll('#results-table tbody tr[data-case]').forEach((tr) => {
        const matchesCase = tr.dataset.case.includes(q);
        const matchesRun = !run || tr.dataset.run === run;
        tr.style.display = matchesCase && matchesRun ? '' : 'none';
      });
    }
    searchInput.addEventListener('input', applyFilters);
    if (runFilter) runFilter.addEventListener('change', applyFilters);
  </script>
</body>
</html>`;

  fs.writeFileSync(outputFile, html, 'utf8');
}

function renderStepCard(step) {
  const evidenceItems = buildEvidenceItemsFromResult(step.result);
  const evidenceHtml = evidenceItems.length
    ? `<ul class="evidence-list">${evidenceItems
        .map(
          (e) => `
        <li class="evidence-item${e.ok ? '' : ' fail'}">
          <span class="evidence-icon">${e.ok ? '&#10003;' : '&#10007;'}</span>
          <div class="evidence-text">
            <span class="evidence-check">${escapeHtml(e.label)}</span>
            <span class="evidence-value">${escapeHtml(e.value)}</span>
          </div>
        </li>`
        )
        .join('')}</ul>`
    : '<p class="empty-note">No evidence captured for this step.</p>';

  const rawJson = escapeHtml(JSON.stringify(step.result ?? {}, null, 2));

  return `
    <div class="step-card ${verdictClassLower(step.status)}">
      <div class="step-number">${escapeHtml(step.id ?? '?')}</div>
      <h3>${escapeHtml(prettifyStepName(step.name))}</h3>
      <div class="step-duration-label">${formatDurationLong(step.durationMs)}</div>
      <span class="badge ${verdictBadgeClass(step.status)}">${escapeHtml(step.status)}</span>
      ${evidenceHtml}
      <details>
        <summary>Raw step result (JSON)</summary>
        <pre>${rawJson}</pre>
      </details>
    </div>`;
}

function renderGallery(screenshots, caseId, outputFile) {
  if (!screenshots.length) {
    return '<p class="empty-note">No screenshots captured for this run.</p>';
  }
  const figures = screenshots
    .map((abs) => {
      const rel = relFromOutput(outputFile, abs);
      const caption = prettifyScreenshotCaption(abs, caseId) || path.basename(abs);
      return `<div class="gallery-item" onclick="openLightbox('${rel}')">
        <img src="${rel}" alt="${escapeHtml(caption)}" loading="lazy" />
        <div class="gallery-label">${escapeHtml(caption)}</div>
      </div>`;
    })
    .join('\n');
  return `<div class="gallery">${figures}</div>`;
}

function renderCriteriaSection(result) {
  if (result.criteriaValidation.length) {
    const items = result.criteriaValidation
      .map((c) => {
        const ok = String(c.status || '').toUpperCase() !== 'FAIL';
        return `
      <li class="evidence-item${ok ? '' : ' fail'}">
        <span class="evidence-icon">${ok ? '&#10003;' : '&#10007;'}</span>
        <div class="evidence-text">
          <span class="evidence-check">${escapeHtml(c.text || '')}</span>
          <span class="evidence-value">${escapeHtml(c.validated_by || '')}</span>
        </div>
      </li>`;
      })
      .join('');
    return `<h3><span class="icon">&#10003;</span>Pass Conditions</h3><ul class="evidence-list">${items}</ul>`;
  }

  if (result.criteriaParsedPass.length) {
    const ok = result.verdict === 'PASS';
    const items = result.criteriaParsedPass
      .map(
        (text) => `
      <li class="evidence-item${ok ? '' : ' fail'}">
        <span class="evidence-icon">${ok ? '&#10003;' : '&#10007;'}</span>
        <div class="evidence-text"><span class="evidence-check">${escapeHtml(text)}</span></div>
      </li>`
      )
      .join('');
    return `<h3><span class="icon">&#10003;</span>Pass Conditions</h3><ul class="evidence-list">${items}</ul>`;
  }

  if (result.criteriaRaw) {
    return `<div class="criteria-box"><strong>Validation Criteria:</strong>\n${escapeHtml(result.criteriaRaw)}</div>`;
  }

  return '<p class="empty-note">No validation criteria recorded for this run.</p>';
}

function renderEvidenceGroupsSection(result) {
  if (!result.evidenceGroups.length) return '';
  const groupsHtml = result.evidenceGroups
    .map(
      (g) => `
      <h3><span class="icon">${g.icon}</span>${escapeHtml(g.title)}</h3>
      <ul class="evidence-list">
        ${g.items
          .map(
            (item) => `
        <li class="evidence-item${item.ok ? '' : ' fail'}">
          <span class="evidence-icon">${item.ok ? '&#10003;' : '&#10007;'}</span>
          <div class="evidence-text">
            <span class="evidence-check">${escapeHtml(item.label)}</span>
            <span class="evidence-value">${escapeHtml(item.value)}</span>
          </div>
        </li>`
          )
          .join('')}
      </ul>`
    )
    .join('\n');
  return `
      <section class="evidence-groups">
        <h2>Detailed Validation Evidence</h2>
        ${groupsHtml}
      </section>`;
}

function renderConclusionSection(result) {
  const cls = verdictClassLower(result.verdict);
  const stepsPassed = result.steps.filter((s) => s.status === 'PASS').length;
  const totalSteps = result.steps.length;

  let headline;
  if (result.verdict === 'PASS') {
    headline = `<strong>Test Case PASSED</strong><br>The test case <strong>${escapeHtml(result.caseId)}</strong> completed its OAuth workflow and met all recorded validation criteria.`;
  } else if (result.verdict === 'FAIL') {
    headline = `<strong>Test Case FAILED</strong><br>The test case <strong>${escapeHtml(result.caseId)}</strong> did not meet the recorded validation criteria. Review the step evidence above for the failing checks.`;
  } else if (result.verdict === 'PARTIAL') {
    headline = `<strong>Test Case PARTIALLY PASSED</strong><br>The test case <strong>${escapeHtml(result.caseId)}</strong> completed core authentication but some optional checks were not fully satisfied.`;
  } else {
    headline = `<strong>Verdict UNKNOWN</strong><br>No validation report was found for <strong>${escapeHtml(result.caseId)}</strong>; this page reflects the raw execution log only.`;
  }

  const bullets = [
    `${result.verdict === 'PASS' ? '&#10003;' : '&#8226;'} ${stepsPassed}/${totalSteps} workflow steps completed successfully`,
    result.score !== null ? `${result.verdict === 'PASS' ? '&#10003;' : '&#8226;'} Validation score: ${result.score}%` : null,
    `${result.screenshots.length > 0 ? '&#10003;' : '&#8226;'} ${result.screenshots.length} screenshot(s) captured as audit trail`,
  ].filter(Boolean);

  return `
      <section>
        <h2>Conclusion</h2>
        <div class="conclusion-box ${cls}">
          <p>${headline}</p>
          <ul>${bullets.map((b) => `<li>${b}</li>`).join('')}</ul>
        </div>
      </section>`;
}

function renderArtifactsSection(result, outputFile) {
  const items = [];
  if (result.executionLogPath) {
    items.push({
      icon: '&#128196;',
      label: 'Execution Log (JSON)',
      display: path.relative(ROOT, result.executionLogPath),
      href: relFromOutput(outputFile, result.executionLogPath),
    });
  }
  if (result.textLogPath && fs.existsSync(result.textLogPath)) {
    items.push({
      icon: '&#128221;',
      label: 'Execution Log (Text)',
      display: path.relative(ROOT, result.textLogPath),
      href: relFromOutput(outputFile, result.textLogPath),
    });
  }
  if (result.screenshots.length) {
    const dir = path.dirname(result.screenshots[0]);
    items.push({
      icon: '&#128444;&#65039;',
      label: 'Screenshots Directory',
      display: `${path.relative(ROOT, dir)} (${result.screenshots.length} file(s))`,
      href: relFromOutput(outputFile, dir),
    });
  }

  if (!items.length) return '';

  return `
      <section>
        <h2>Test Artifacts</h2>
        <div class="artifact-box">
          <ul class="evidence-list">
            ${items
              .map(
                (item) => `
            <li class="evidence-item">
              <span class="evidence-icon">${item.icon}</span>
              <div class="evidence-text">
                <span class="evidence-check">${escapeHtml(item.label)}</span>
                <span class="evidence-value"><a href="${item.href}">${escapeHtml(item.display)}</a></span>
              </div>
            </li>`
              )
              .join('')}
          </ul>
        </div>
      </section>`;
}

function renderDetailPage(result, detailsDir) {
  const outputFile = path.join(detailsDir, `${result.id}.html`);
  const stepsPassed = result.steps.filter((s) => s.status === 'PASS').length;
  const totalSteps = result.steps.length;
  const evidenceTotal = result.evidenceItems.length || totalSteps;
  const evidencePassed = result.evidenceItems.length
    ? result.evidenceItems.filter((e) => String(e.status || '').toUpperCase() !== 'FAIL').length
    : stepsPassed;
  const effectiveScore = result.score !== null ? result.score : (totalSteps ? Math.round((stepsPassed / totalSteps) * 100) : 0);

  const stepsHtml = result.steps.length
    ? `<div class="step-grid">${result.steps.map((s) => renderStepCard(s)).join('\n')}</div>`
    : '<p class="empty-note">No step data available.</p>';
  const galleryHtml = renderGallery(result.screenshots, result.caseId, outputFile);
  const cls = verdictClassLower(result.verdict);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RAS Test Case Validation Dashboard - ${escapeHtml(result.caseId)}</title>
<style>${baseStyles()}</style>
</head>
<body>
  <div class="container">
    <header>
      <h1>RAS Test Case Validation Dashboard</h1>
      <p>Test Case: <strong>${escapeHtml(result.caseId)}</strong>${result.runFolder ? ` &middot; Run: ${escapeHtml(result.runFolder)}` : ''}</p>
      <div class="verdict-pill ${cls}">${verdictIcon(result.verdict)} ${verdictLabel(result.verdict)}</div>
    </header>
    <div class="content">
      <a class="back-link" href="../index.html">&larr; Back to dashboard</a>

      <section>
        <div class="score-wrap">
          <div class="score-circle" style="border-color: ${scoreColor(result.verdict)};">
            <div class="score-value">${effectiveScore}%</div>
            <div class="score-label">Success Score</div>
          </div>
        </div>
      </section>

      <section>
        <h2>Key Metrics</h2>
        <div class="stat-grid">
          <div class="stat-box"><div class="stat-value">${stepsPassed}/${totalSteps}</div><div class="stat-label">Steps Completed</div></div>
          <div class="stat-box"><div class="stat-value">${formatDuration(result.totalDurationMs)}</div><div class="stat-label">Total Duration</div></div>
          <div class="stat-box"><div class="stat-value">${evidencePassed}/${evidenceTotal}</div><div class="stat-label">Validation Checks</div></div>
          <div class="stat-box"><div class="stat-value">${result.screenshots.length}</div><div class="stat-label">Screenshots</div></div>
        </div>
      </section>

      <section>
        <h2>Test Case Information</h2>
        <div class="meta-grid">
          <div class="meta-item"><label>Case ID</label><div class="val">${escapeHtml(result.caseId)}</div></div>
          ${result.idp ? `<div class="meta-item"><label>Identity Provider</label><div class="val">${escapeHtml(result.idp)}</div></div>` : ''}
          <div class="meta-item"><label>Run Folder</label><div class="val">${result.runFolder ? escapeHtml(result.runFolder) : 'legacy'}</div></div>
          <div class="meta-item"><label>Execution Date</label><div class="val">${formatDate(result.executionStart)}</div></div>
          <div class="meta-item"><label>Validation Date</label><div class="val">${formatDate(result.generatedAt)}</div></div>
          <div class="meta-item"><label>Source</label><div class="val">${escapeHtml(result.source)}</div></div>
        </div>
      </section>

      <section>
        <h2>Validation Criteria</h2>
        ${renderCriteriaSection(result)}
      </section>

      <section>
        <h2>OAuth Workflow Step Results</h2>
        ${stepsHtml}
      </section>
      ${renderEvidenceGroupsSection(result)}

      <section>
        <h2>Screenshot Gallery</h2>
        <p style="color:#666;margin-bottom:20px;">Screenshots captured during workflow execution for this test run.</p>
        ${galleryHtml}
      </section>
      ${renderArtifactsSection(result, outputFile)}
      ${renderConclusionSection(result)}
    </div>
    <div class="timestamp-footer">
      <strong>Report Generated:</strong> ${escapeHtml(formatDate(result.generatedAt))} &nbsp;|&nbsp;
      <strong>Execution Window:</strong> ${escapeHtml(formatDate(result.executionStart))} &rarr; ${escapeHtml(formatDate(result.executionEnd))} &nbsp;|&nbsp;
      <strong>Source:</strong> ${escapeHtml(result.source)}
    </div>
  </div>

  <div id="lightbox" onclick="closeLightbox()">
    <span class="hint">Click anywhere to close</span>
    <img id="lightbox-img" src="" alt="Screenshot preview" />
  </div>
  <script>
    function openLightbox(src) {
      const lb = document.getElementById('lightbox');
      document.getElementById('lightbox-img').src = src;
      lb.classList.add('open');
    }
    function closeLightbox() {
      document.getElementById('lightbox').classList.remove('open');
    }
  </script>
</body>
</html>`;

  fs.writeFileSync(outputFile, html, 'utf8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { run: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--run' || arg === '--run-folder') {
      args.run = argv[i + 1] || null;
      i += 1;
    } else if (arg.startsWith('--run=')) {
      args.run = arg.slice('--run='.length) || null;
    } else if (arg === '--latest') {
      args.run = 'latest';
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('Scanning test-results/ for validation reports and execution logs...');
  let results = collectResults();
  console.log(`Found ${results.length} test case result(s) across all runs.`);

  const availableRunFolders = [...new Set(results.map((r) => r.runFolder).filter(Boolean))].sort();
  let appliedRunFilter = null;

  if (args.run) {
    const targetRun = args.run === 'latest' ? availableRunFolders[availableRunFolders.length - 1] : args.run;
    if (!targetRun) {
      console.warn('  ! No timestamped run folders found; ignoring --run filter.');
    } else {
      const before = results.length;
      results = results.filter((r) => r.runFolder === targetRun);
      appliedRunFilter = targetRun;
      console.log(`Filtered to run "${targetRun}": ${results.length}/${before} test case result(s).`);
      if (!results.length) {
        console.warn(`  ! No results matched run "${targetRun}".`);
        if (availableRunFolders.length) {
          console.warn(`    Available runs:\n      ${availableRunFolders.join('\n      ')}`);
        }
      }
    }
  }

  const genTimestamp = timestampFolderName();
  const outputDir = path.join(DASHBOARD_ROOT, genTimestamp);
  const detailsDir = path.join(outputDir, 'details');
  fs.mkdirSync(detailsDir, { recursive: true });

  renderIndexPage(results, path.join(outputDir, 'index.html'), appliedRunFilter);
  for (const result of results) {
    renderDetailPage(result, detailsDir);
  }

  console.log(`\nDashboard generated:`);
  console.log(`  ${path.relative(ROOT, path.join(outputDir, 'index.html'))}`);
  console.log(`  ${path.relative(ROOT, detailsDir)}/ (${results.length} detail page(s))`);
  console.log(`\nOpen it with: open ${path.relative(ROOT, path.join(outputDir, 'index.html'))}`);
}

main();
