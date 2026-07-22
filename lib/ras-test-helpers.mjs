import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnv(file = path.join(projectDir, ".env")) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv();

export const env = (name, fallback = "") => process.env[name] || fallback;
export const rasUrl = (pathName) => new URL(pathName, env("RAS_BASE_URL", "https://stsstg.nih.gov")).toString();

export function requireEnv(t, names) {
  const missing = names.filter((name) => !env(name));
  if (!missing.length) return true;
  t.skip(`Missing environment values: ${missing.join(", ")}`);
  return false;
}

export async function request(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(env("HTTP_TIMEOUT_MS", "30000")));
  const started = performance.now();
  try {
    const response = await fetch(url, { redirect: "manual", ...options, signal: controller.signal });
    const text = await response.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* retain text */ }
    return { response, body, text, elapsedMs: performance.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

export async function formPost(url, fields, headers = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined && value !== "") body.set(key, value);
  return request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers },
    body,
  });
}

export async function exchangeAuthorizationCode(code = env("AUTHORIZATION_CODE")) {
  return formPost(rasUrl(env("RAS_TOKEN_PATH", "/auth/oauth/v2/token")), {
    grant_type: "authorization_code",
    scope: env("RAS_SCOPE"),
    redirect_uri: env("REDIRECT_URI"),
    client_id: env("RAS_CLIENT_ID"),
    client_secret: env("RAS_CLIENT_SECRET"),
    code,
  });


}

export async function refreshAccessToken(refreshToken = env("REFRESH_TOKEN")) {
  return formPost(rasUrl(env("RAS_TOKEN_PATH", "/auth/oauth/v2/token")), {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env("RAS_CLIENT_ID"),
    client_secret: env("RAS_CLIENT_SECRET"),
    scope: env("RAS_SCOPE"),
  });
}

export async function getUserInfo(accessToken = env("ACCESS_TOKEN")) {
  return request(rasUrl(env("RAS_USERINFO_PATH", "/openid/connect/v1.1/userinfo")), {
    method: env("RAS_USERINFO_METHOD", "POST"),
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
}

export function decodeJwt(token) {
  assert.equal(typeof token, "string", "JWT must be a string");
  const parts = token.split(".");
  assert.equal(parts.length, 3, "JWT must have three segments");
  const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  return { header: decode(parts[0]), payload: decode(parts[1]), signature: parts[2] };
}

export function extractPassport(userInfo) {
  const claim = Array.isArray(userInfo?.ga4gh_passport_v1)
    ? userInfo.ga4gh_passport_v1
    : (typeof userInfo?.passport_jwt_v11 === "string" ? [userInfo.passport_jwt_v11] : null);
  assert.ok(
    Array.isArray(claim) && claim.length > 0,
    "userinfo must contain a non-empty ga4gh_passport_v1 array or passport_jwt_v11 token",
  );
  const passportTokens = claim.filter((value) => typeof value === "string");
  const decoded = passportTokens.map(decodeJwt);
  const visas = decoded.flatMap(({ payload }) => Array.isArray(payload.ga4gh_passport_v1) ? payload.ga4gh_passport_v1 : []);
  return { claim, passportTokens, decoded, visas };
}

export function assertJwtIntegrity(decoded) {
  assert.ok(decoded.header.alg && decoded.header.alg !== "none", "JWT must use a signing algorithm");
  assert.ok(decoded.payload.iss, "JWT issuer is required");
  assert.ok(decoded.payload.exp, "JWT expiry is required");
  assert.ok(decoded.payload.exp * 1000 > Date.now(), "JWT must not be expired");
  assert.ok(decoded.signature, "JWT signature segment is required");
}

export async function validateVisas(visas) {
  const results = [];
  for (const visa of visas) {
    results.push(await formPost(rasUrl(env("RAS_VALIDATE_PATH", "/passport/validate")), { visa }));
  }
  return results;
}

export async function requestDrsAccess(url, passports) {
  return request(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ passports }),
  });
}

function findUrl(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["url", "access_url", "signed_url", "signedUrl", "href"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && /^https?:\/\//.test(candidate)) return candidate;
    const nested = findUrl(candidate);
    if (nested) return nested;
  }
  for (const candidate of Object.values(value)) {
    const nested = findUrl(candidate);
    if (nested) return nested;
  }
  return null;
}

export function extractSignedUrl(body) {
  const url = findUrl(body);
  assert.ok(url, "DRS response must include an HTTP(S) signed URL");
  return url;
}

export async function verifySignedUrl(url) {
  const parsed = new URL(url);
  const expiry = parsed.searchParams.get("X-Amz-Expires") || parsed.searchParams.get("Expires");
  if (expiry) assert.ok(Number(expiry) > 0, "signed URL expiry must be positive");
  const result = await request(url, { method: "GET" });
  assert.ok(result.response.status >= 200 && result.response.status < 400, `signed URL returned ${result.response.status}`);
  return result;
}

export function studyIdsFromVisas(visas) {
  const found = new Set();
  for (const visa of visas) {
    const text = JSON.stringify(decodeJwt(visa).payload);
    for (const match of text.matchAll(/phs\d+(?:\.v\d+)?(?:\.p\d+)?/gi)) found.add(match[0].toLowerCase());
  }
  return found;
}

export function assertSuccess(result, label) {
  assert.ok(result.response.ok, `${label} returned ${result.response.status}: ${result.text.slice(0, 300)}`);
}
