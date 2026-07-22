import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import {
  assertJwtIntegrity,
  assertSuccess,
  decodeJwt,
  env,
  exchangeAuthorizationCode,
  extractPassport,
  extractSignedUrl,
  formPost,
  getUserInfo,
  rasUrl,
  refreshAccessToken,
  requestDrsAccess,
  validateVisas,
  verifySignedUrl,
} from "../lib/ras-test-helpers.mjs";

function requireSetting(context, names) {
  const missing = names.filter((name) => !context.settings[name]);
  if (missing.length) throw new Error(`Missing required settings: ${missing.join(", ")}`);
}

function setRuntimeValue(context, key, value) {
  context.data[key] = value;
  if (value !== undefined && value !== null && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
    process.env[key] = String(value);
  }
}

function normalizePathname(pathname) {
  if (!pathname || pathname === "/") return "/";
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function isExpectedRedirectUrl(candidateUrl, redirectUri) {
  try {
    const candidate = new URL(candidateUrl);
    const expected = new URL(redirectUri);
    return candidate.origin === expected.origin && normalizePathname(candidate.pathname) === normalizePathname(expected.pathname);
  } catch {
    return false;
  }
}

function authorizationUrl() {
  const url = new URL(env("RAS_AUTHORIZE_PATH", "/auth/oauth/v2/authorize"), env("RAS_BASE_URL", "https://stsstg.nih.gov"));
  url.searchParams.set("client_id", env("RAS_CLIENT_ID"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", env("REDIRECT_URI"));
  url.searchParams.set("scope", env("RAS_SCOPE"));
  return url.toString();
}

async function clickButton(page, name) {
  const button = page.getByRole("button", { name }).or(page.getByRole("link", { name })).first();
  await button.waitFor({ state: "visible" });
  await button.click();
}

function safeFileName(name) {
  return String(name || "workflow-run").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "workflow-run";
}

async function captureScreenshot(page, screenshotDir, description, testCaseName) {
  try {
    await mkdir(screenshotDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
    const casePart = safeFileName(testCaseName);
    const stepPart = description.replace(/\s+/g, "_");
    const filename = `${timestamp}_${casePart}_${stepPart}.png`;
    const filepath = `${screenshotDir}/${filename}`;
    await page.screenshot({ path: filepath });
    console.log(`Screenshot saved: ${filepath}`);
  } catch (error) {
    console.warn(`Failed to capture screenshot (${description}):`, error.message);
  }
}

async function completeIdMeSignIn(page, screenshotDir, testCaseName) {
  await page.getByRole("textbox", { name: /email/i }).fill(env("EMAIL"));
  await page.waitForTimeout(1000);
  await captureScreenshot(page, screenshotDir, "01-email-entered", testCaseName);
  await clickButton(page, /continue/i);
  await page.waitForTimeout(1000);

  const passwordInput = page.locator('input[type="password"][autocomplete="current-password"], input[type="password"][name="user[password]"]').first();
  await passwordInput.waitFor({ state: "visible" });
  await page.waitForTimeout(1000);
  await captureScreenshot(page, screenshotDir, "02-password-page", testCaseName);
  await passwordInput.fill(env("PASSWORD"));
  await page.waitForTimeout(1000);
  await clickButton(page, /continue|sign in/i);
  await page.waitForTimeout(1000);
  await captureScreenshot(page, screenshotDir, "03-password-submitted", testCaseName);

  await page.getByText(/complete your sign in/i).first().waitFor({ state: "visible" });
  await page.waitForTimeout(1000);
  await captureScreenshot(page, screenshotDir, "04-complete-signin-page", testCaseName);
  await clickButton(page, /continue/i);
  await page.waitForTimeout(1000);

  const codeInputs = page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"]');
  await codeInputs.first().waitFor({ state: "visible" });
  await page.waitForTimeout(1000);
  await captureScreenshot(page, screenshotDir, "05-mfa-code-page", testCaseName);

  const suppliedCode = env("MFA_CODE");
  const inputCount = await codeInputs.count();
  const currentCode = (await Promise.all(
    Array.from({ length: inputCount }, (_, index) => codeInputs.nth(index).inputValue()),
  )).join("");

  if (!currentCode && suppliedCode) {
    if (inputCount === 1) {
      await codeInputs.first().fill(suppliedCode);
    } else {
      assert.equal(suppliedCode.length, inputCount, `IDME_CODE must contain ${inputCount} characters`);
      for (let index = 0; index < inputCount; index += 1) await codeInputs.nth(index).fill(suppliedCode[index]);
    }
    await page.waitForTimeout(1000);
  }

  const enteredCode = (await Promise.all(
    Array.from({ length: inputCount }, (_, index) => codeInputs.nth(index).inputValue()),
  )).join("");
  assert.ok(enteredCode, "The ID.me verification code was not prefilled; set MFA_CODE in the user settings file");
  await clickButton(page, /continue/i);
  await page.waitForTimeout(1000);
  await captureScreenshot(page, screenshotDir, "06-mfa-code-submitted", testCaseName);
}

async function completeLoginGovSignIn(page, screenshotDir, testCaseName) {
  // Email input and submit
  await page.getByRole("textbox", { name: /email/i }).fill(env("EMAIL"));
  await page.waitForTimeout(1000);
  await captureScreenshot(page, screenshotDir, "01-email-entered", testCaseName);
  // Password input and submit
  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.waitFor({ state: "visible" });
  await page.waitForTimeout(1000);
  await captureScreenshot(page, screenshotDir, "02-password-page", testCaseName);
  await passwordInput.fill(env("PASSWORD"));
  await page.waitForTimeout(1000);
  await clickButton(page, /submit/i);
  await page.waitForTimeout(2000);
  await captureScreenshot(page, screenshotDir, "03-password-submitted", testCaseName);

  // One-time code page - wait for user to enter code manually
  const codeInputs = page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[pattern="[0-9]*"]');
  await codeInputs.first().waitFor({ state: "visible" });
  await captureScreenshot(page, screenshotDir, "04-mfa-code-page", testCaseName);
  await page.waitForTimeout(10000);

  // Wait for user to fill in the code manually
  const inputCount = await codeInputs.count();
  let allFilled = false;
  let attempts = 0;
  const maxAttempts = 600; // 10 minutes with 1-second checks

  while (!allFilled && attempts < maxAttempts) {
    const codes = await Promise.all(
      Array.from({ length: inputCount }, (_, index) => codeInputs.nth(index).inputValue()),
    );
    const allCodesEntered = codes.every((code) => code && code.trim().length > 0);
    if (allCodesEntered) {
      allFilled = true;
    } else {
      await page.waitForTimeout(1000);
      attempts += 1;
    }
  }

  assert.ok(allFilled, "Timeout waiting for user to enter login.gov verification code");
  await clickButton(page, /submit|continue/i);
  await page.waitForTimeout(2000);
  await captureScreenshot(page, screenshotDir, "05-mfa-code-submitted", testCaseName);

  // Wait for "Switch to an identity" page and click login.gov (optional - skip if not shown)
  try {
    await page.getByText(/switch to an identity|meet.*security/i).first().waitFor({ state: "visible", timeout: 5000 });
    await page.waitForTimeout(1000);
    await captureScreenshot(page, screenshotDir, "06-switch-identity-page", testCaseName);
    await clickButton(page, /login\.gov/i);
    await page.waitForTimeout(2000);
    await captureScreenshot(page, screenshotDir, "07-after-identity-selection", testCaseName);
  } catch {
    // Page not shown, continue
  }

  // Handle consent screen if present
  try {
    const grantButton = page.getByRole("button", { name: /grant|allow|authorize|consent/i }).first();
    await grantButton.waitFor({ state: "visible", timeout: 5000 });
    await captureScreenshot(page, screenshotDir, "08-consent-page", testCaseName);
    await grantButton.click();
    await page.waitForTimeout(1000);
    await captureScreenshot(page, screenshotDir, "09-after-consent", testCaseName);
  } catch {
    // No consent screen, continue
  }
}

async function stepAuthorize(context) {
  const idp = env("IDP", "id.me").toLowerCase();
  const isIdMe = idp.match(/^id\.?me$/);
  const isLoginGov = idp.match(/^login\.?gov$/);

  requireSetting(context, ["RAS_CLIENT_ID", "REDIRECT_URI", "RAS_SCOPE", "EMAIL", "PASSWORD"]);

  if (!isIdMe && !isLoginGov) {
    throw new Error(`Unsupported IDP: ${env("IDP")}. Supported values: id.me, login.gov`);
  }

  const screenshotDir = context.screenshotDir || env("WORKFLOW_SCREENSHOT_DIR", "test-results/screenshots");
  const testCaseName = context.testCaseName || "workflow-run";

  const browser = await chromium.launch({
    headless: env("HEADLESS", "false").toLowerCase() === "true",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const pageContext = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  });
  await pageContext.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await pageContext.newPage();
  page.setDefaultTimeout(Number(env("BROWSER_TIMEOUT_MS", "180000")));

  try {
    await page.goto(authorizationUrl(), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await captureScreenshot(page, screenshotDir, "00-ras-login-page", testCaseName);

    if (isIdMe) {
      await clickButton(page, /id\.me/i);
      await page.waitForTimeout(2000);
      await captureScreenshot(page, screenshotDir, "00-idme-button-clicked", testCaseName);
      await completeIdMeSignIn(page, screenshotDir, testCaseName);
    } else if (isLoginGov) {
      await clickButton(page, /login\.gov/i);
      await page.waitForTimeout(2000);
      await captureScreenshot(page, screenshotDir, "00-logingov-button-clicked", testCaseName);
      await completeLoginGovSignIn(page, screenshotDir, testCaseName);
    }

    await page.waitForTimeout(2000);
    await captureScreenshot(page, screenshotDir, "10-before-authorization", testCaseName);
    
    // Wait for authorization screen and click allow (optional - skip if not shown)
    try {
      await page.getByText(/authorize xms int/i).first().waitFor({ state: "visible", timeout: 5000 });
      await page.waitForTimeout(1000);
      await captureScreenshot(page, screenshotDir, "11-authorization-page", testCaseName);
      await clickButton(page, /allow/i);
      await page.waitForTimeout(1000);
      await captureScreenshot(page, screenshotDir, "12-after-authorization", testCaseName);
    } catch {
      // Authorization screen not shown, continue
    }

    const callbackRequest = await page.waitForRequest((request) => {
      const requestUrl = request.url();
      if (!isExpectedRedirectUrl(requestUrl, env("REDIRECT_URI"))) return false;
      try {
        return new URL(requestUrl).searchParams.has("code");
      } catch {
        return false;
      }
    });

    const callbackUrl = new URL(callbackRequest.url());
    const authorizationCode = callbackUrl.searchParams.get("code");
    assert.ok(authorizationCode, " callback URL must contain an authorization code");
    setRuntimeValue(context, "authorizationCode", authorizationCode);
    setRuntimeValue(context, "authorizationCallbackUrl", callbackUrl.toString());
    return {
      callbackOrigin: callbackUrl.origin,
      callbackPath: callbackUrl.pathname,
      capturedCode: true,
    };
  } finally {
    await browser.close();
  }
}

async function stepExchangeAuthorizationCode(context) {
  const code = context.data.authorizationCode || context.settings.AUTHORIZATION_CODE;
  assert.ok(code, "Step 2 requires an authorization code from step 1 or AUTHORIZATION_CODE in settings");
  const exchanged = await exchangeAuthorizationCode(code);
  context.logger.info("API call: exchange authorization code", {
    url: exchanged.response.url,
    method: "POST",
    status: exchanged.response.status,
    elapsedMs: exchanged.elapsedMs,
    responseBody: exchanged.body,
  });
  assertSuccess(exchanged, "authorization code exchange");
  setRuntimeValue(context, "authorizationCode", code);
  setRuntimeValue(context, "accessToken", exchanged.body.access_token);
  setRuntimeValue(context, "refreshToken", exchanged.body.refresh_token);
  setRuntimeValue(context, "idToken", exchanged.body.id_token);
  context.data.tokenResponse = exchanged.body;
  return {
    status: exchanged.response.status,
    hasAccessToken: Boolean(exchanged.body.access_token),
    hasRefreshToken: Boolean(exchanged.body.refresh_token),
    hasIdToken: Boolean(exchanged.body.id_token),
  };
}

async function stepUserInfo(context) {
  const accessToken = context.data.accessToken || context.settings.ACCESS_TOKEN;
  assert.ok(accessToken, "Step 3 requires an access token from step 2/8 or ACCESS_TOKEN in settings");
  const info = await getUserInfo(accessToken);
  context.logger.info("API call: userinfo", {
    url: info.response.url,
    method: env("RAS_USERINFO_METHOD", "POST"),
    status: info.response.status,
    elapsedMs: info.elapsedMs,
    responseBody: info.body,
  });
  assertSuccess(info, "userinfo");
  context.data.userInfo = info.body;
  return {
    status: info.response.status,
    subject: info.body?.sub,
    hasPassportClaim: Array.isArray(info.body?.ga4gh_passport_v1) || Boolean(info.body?.passport_jwt_v11),
  };
}

async function stepDecodePassport(context) {
  assert.ok(context.data.userInfo, "Step 4 requires userinfo from step 3");
  const passport = extractPassport(context.data.userInfo);
  passport.decoded.forEach(assertJwtIntegrity);
  passport.visas.map(decodeJwt).forEach(assertJwtIntegrity);
  context.data.passport = passport;
  return {
    passportTokenCount: passport.passportTokens.length,
    visaCount: passport.visas.length,
  };
}

async function stepGetConsentGroups(context) {
  assert.ok(context.data.passport, "This step requires passport data from step 4 (decode-passport)");
  const { decoded } = context.data.passport;
  assert.ok(Array.isArray(decoded) && decoded.length > 0, "This step requires decoded passport tokens from step 4");

  const consentGroups = [];
  decoded.forEach((passportToken, passportIndex) => {
    const visas = passportToken.payload?.ga4gh_passport_v1;
    assert.ok(
      Array.isArray(visas) && visas.length >= 2,
      `Passport token ${passportIndex} must contain at least 2 visas (identity visa + consent visa) in ga4gh_passport_v1`,
    );

    // The second visa (index 1) carries the ras_dbgap_permissions consent-group claims.
    const consentVisa = decodeJwt(visas[1]);
    assertJwtIntegrity(consentVisa);

    const permissions = consentVisa.payload?.ras_dbgap_permissions;
    assert.ok(
      Array.isArray(permissions),
      `Passport token ${passportIndex}'s consent visa must contain a ras_dbgap_permissions array`,
    );

    for (const permission of permissions) {
      consentGroups.push({
        passportIndex,
        consent_name: permission.consent_name,
        phs_id: `${permission.phs_id}.${permission.consent_group}`,
        version: permission.version,
        participant_set: permission.participant_set,
        role: permission.role,
        expiration: permission.expiration,
      });
    }
  });

  context.data.consentGroups = consentGroups;
  context.logger.info("Consent groups extracted from passport", { consentGroups });

  return {
    consentGroupCount: consentGroups.length,
    consentGroups,
  };
}

async function stepValidateVisas(context) {
  assert.ok(context.data.passport, "Step 5 requires passport data from step 4");
  const validations = await validateVisas(context.data.passport.visas);
  validations.forEach((validation, index) => {
    context.logger.info(`API call: validate visa ${index + 1}`, {
      url: validation.response.url,
      method: "POST",
      status: validation.response.status,
      elapsedMs: validation.elapsedMs,
      responseBody: validation.body,
    });
    assertSuccess(validation, `visa validation ${index + 1}`);
  });
  context.data.visaValidationResults = validations.map((validation) => ({
    status: validation.response.status,
    body: validation.body,
  }));
  return {
    validatedVisas: validations.length,
  };
}

async function stepRequestDrsAccess(context) {
  const passports = context.data.passport?.passportTokens;
  assert.ok(Array.isArray(passports) && passports.length > 0, "Step 6 requires passport tokens from step 4");
  const drsUrl = context.settings.DRS_ACCESS_URL || context.settings.DCF_DRS_ACCESS_URL || context.settings.AUTHORIZED_DRS_URL;
  assert.ok(drsUrl, "Step 6 requires DRS_ACCESS_URL, DCF_DRS_ACCESS_URL, or AUTHORIZED_DRS_URL in settings");
  const drs = await requestDrsAccess(drsUrl, passports);
  context.logger.info("API call: DRS access request", {
    url: drs.response.url,
    method: "POST",
    status: drs.response.status,
    elapsedMs: drs.elapsedMs,
    responseBody: drs.body,
  });
  assertSuccess(drs, "DRS access request");
  context.data.drsResponse = drs.body;
  context.data.signedUrl = extractSignedUrl(drs.body);
  return {
    status: drs.response.status,
    hasSignedUrl: Boolean(context.data.signedUrl),
  };
}

async function stepVerifySignedUrl(context) {
  const signedUrl = context.data.signedUrl;
  assert.ok(signedUrl, "Step 7 requires a signed URL from step 6");
  const verified = await verifySignedUrl(signedUrl);
  context.logger.info("API call: verify signed URL", {
    url: verified.response.url,
    method: "GET",
    status: verified.response.status,
    elapsedMs: verified.elapsedMs,
    responseBody: verified.body,
  });
  context.data.signedUrlVerification = {
    status: verified.response.status,
    elapsedMs: verified.elapsedMs,
  };
  return context.data.signedUrlVerification;
}

async function stepRefreshAccessToken(context) {
  const refreshToken = context.data.refreshToken || context.settings.REFRESH_TOKEN;
  assert.ok(refreshToken, "Step 8 requires a refresh token from step 2 or REFRESH_TOKEN in settings");
  const refreshed = await refreshAccessToken(refreshToken);
  context.logger.info("API call: refresh access token", {
    url: refreshed.response.url,
    method: "POST",
    status: refreshed.response.status,
    elapsedMs: refreshed.elapsedMs,
    responseBody: refreshed.body,
  });
  assertSuccess(refreshed, "refresh token exchange");
  setRuntimeValue(context, "accessToken", refreshed.body.access_token);
  if (refreshed.body.refresh_token) setRuntimeValue(context, "refreshToken", refreshed.body.refresh_token);
  context.data.refreshResponse = refreshed.body;
  return {
    status: refreshed.response.status,
    hasAccessToken: Boolean(refreshed.body.access_token),
    rotatedRefreshToken: Boolean(refreshed.body.refresh_token),
  };
}

async function stepRevokeToken(context) {
  requireSetting(context, ["RAS_CLIENT_ID", "RAS_CLIENT_SECRET"]);
  const token = context.data.accessToken || context.settings.ACCESS_TOKEN;
  assert.ok(token, "Step 9 requires an access token from step 2/8 or ACCESS_TOKEN in settings");
  const revoked = await formPost(rasUrl("/auth/oauth/v2/token/revoke"), {
    client_id: context.settings.RAS_CLIENT_ID,
    client_secret: context.settings.RAS_CLIENT_SECRET,
    token_type_hint: "access_token",
    token,
  });
  context.logger.info("API call: revoke token", {
    url: revoked.response.url,
    method: "POST",
    status: revoked.response.status,
    elapsedMs: revoked.elapsedMs,
    responseBody: revoked.body,
  });
  assert.ok(revoked.response.status >= 200 && revoked.response.status < 400, `revoke returned ${revoked.response.status}`);
  context.data.revokeResponse = revoked.body;
  return {
    status: revoked.response.status,
  };
}

async function stepLogout(context) {
  requireSetting(context, ["RAS_CLIENT_ID", "RAS_CLIENT_SECRET"]);
  const idToken = context.data.idToken || context.settings.ID_TOKEN;
  assert.ok(idToken, "Step 10 requires an id token from step 2 or ID_TOKEN in settings");
  const logout = await formPost(rasUrl("/connect/session/logout"), {
    client_id: context.settings.RAS_CLIENT_ID,
    client_secret: context.settings.RAS_CLIENT_SECRET,
    id_token: idToken,
  });
  context.logger.info("API call: logout", {
    url: logout.response.url,
    method: "POST",
    status: logout.response.status,
    elapsedMs: logout.elapsedMs,
    responseBody: logout.body,
  });
  assert.ok(logout.response.status >= 200 && logout.response.status < 400, `logout returned ${logout.response.status}`);
  context.data.logoutResponse = logout.body;
  return {
    status: logout.response.status,
    sessionStatus: logout.body?.session_status,
  };
}

async function stepExportContext(context) {
  return {
    keys: Object.keys(context.data).sort(),
  };
}

export const stepRegistry = new Map([
  [1, { id: 1, name: "authorize-login", run: stepAuthorize }],
  [2, { id: 2, name: "exchange-authorization-code", run: stepExchangeAuthorizationCode }],
  [3, { id: 3, name: "userinfo", run: stepUserInfo }],
  [4, { id: 4, name: "decode-passport", run: stepDecodePassport }],
  [5, { id: 5, name: "validate-visas", run: stepValidateVisas }],
  [6, { id: 6, name: "request-drs-access", run: stepRequestDrsAccess }],
  [7, { id: 7, name: "verify-signed-url", run: stepVerifySignedUrl }],
  [8, { id: 8, name: "refresh-access-token", run: stepRefreshAccessToken }],
  [9, { id: 9, name: "revoke-token", run: stepRevokeToken }],
  [10, { id: 10, name: "logout", run: stepLogout }],
  [11, { id: 11, name: "export-context", run: stepExportContext }],
  [12, { id: 12, name: "get-consent-groups", run: stepGetConsentGroups }],
]);

export function getStep(id) {
  const step = stepRegistry.get(id);
  if (!step) throw new Error(`Unknown step id: ${id}`);
  return step;
}
