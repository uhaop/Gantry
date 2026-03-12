import { BaseCdpClient, ClientDomains } from "./BaseCdpClient";
import { CursorCdpClient } from "../cursor/CursorCdpClient";
import { WindsurfCdpClient } from "../windsurf/WindsurfCdpClient";
import { VscodeCdpClient } from "../vscode/VscodeCdpClient";
import { config } from "../config";
import { logger } from "../logger";

export interface SelectorProbeResult {
  selector: string;
  matches: number;
  /** true if at least one match is visible in the viewport */
  hasVisible: boolean;
}

export interface DiscoveredCandidate {
  selector: string;
  tag: string;
  role: string | null;
  className: string;
  visible: boolean;
  score: number;
}

export interface PreflightReport {
  ide: "cursor" | "windsurf" | "vscode";
  cdpUrl: string;
  connectivity: {
    reachable: boolean;
    versionOk: boolean;
    userAgent: string | null;
    targetCount: number;
    pageTargetCount: number;
  };
  selectors: {
    chatInput: SelectorProbeResult;
    response: SelectorProbeResult;
    modeIndicator: SelectorProbeResult;
  };
  discovery: {
    chatInputCandidates: DiscoveredCandidate[];
    responseCandidates: DiscoveredCandidate[];
    modeIndicatorCandidates: DiscoveredCandidate[];
  };
  warnings: string[];
  suggestions: string[];
}

function createCdpClient(): BaseCdpClient {
  if (config.bridgeIdeTarget === "windsurf") return new WindsurfCdpClient();
  if (config.bridgeIdeTarget === "vscode") return new VscodeCdpClient();
  return new CursorCdpClient();
}

function getConfiguredSelectors(): { chatInput: string; response: string; mode: string } {
  if (config.bridgeIdeTarget === "windsurf") {
    return {
      chatInput: config.windsurfChatInputSelector,
      response: config.windsurfResponseSelector,
      mode: ""
    };
  }
  if (config.bridgeIdeTarget === "vscode") {
    return {
      chatInput: config.vscodeChatInputSelector,
      response: config.vscodeResponseSelector,
      mode: config.vscodeModeSelector
    };
  }
  return {
    chatInput: config.cursorChatInputSelector,
    response: config.cursorResponseSelector,
    mode: ""
  };
}

/**
 * Probes a CSS selector against the live DOM, returning match count and visibility.
 */
async function probeSelector(
  cdp: BaseCdpClient,
  client: ClientDomains,
  selector: string
): Promise<SelectorProbeResult> {
  if (!selector) {
    return { selector: "(empty)", matches: 0, hasVisible: false };
  }
  const result = await cdp.evaluateJson<{ matches: number; hasVisible: boolean }>(
    client,
    `(() => {
      try {
        const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
        const hasVisible = nodes.some(el => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 3 && r.height > 3 && s.visibility !== 'hidden' && s.display !== 'none';
        });
        return { matches: nodes.length, hasVisible };
      } catch (e) {
        return { matches: -1, hasVisible: false };
      }
    })()`
  );
  return {
    selector,
    matches: result?.matches ?? -1,
    hasVisible: result?.hasVisible ?? false
  };
}

/**
 * Auto-discovers chat input candidates from the live DOM.
 */
async function discoverChatInputCandidates(
  cdp: BaseCdpClient,
  client: ClientDomains
): Promise<DiscoveredCandidate[]> {
  const raw = await cdp.evaluateJson<DiscoveredCandidate[]>(
    client,
    `(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 3 && r.height > 3 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const candidates = [
        ...Array.from(document.querySelectorAll('[role="textbox"]')),
        ...Array.from(document.querySelectorAll('[contenteditable="true"]')),
        ...Array.from(document.querySelectorAll('textarea'))
      ];
      const seen = new Set();
      return candidates.filter(el => {
        if (seen.has(el)) return false;
        seen.add(el);
        return true;
      }).slice(0, 15).map(el => {
        const r = el.getBoundingClientRect();
        const vis = isVisible(el);
        const cls = String(el.className || '').replace(/\\s+/g, ' ').trim().substring(0, 150);
        const role = el.getAttribute('role');
        const tag = el.tagName.toLowerCase();
        let score = 0;
        if (vis) score += 100;
        if (role === 'textbox') score += 50;
        if (cls.includes('xterm')) score -= 500;
        if (el.closest('[class*="chat"]') || el.closest('[class*="cascade"]') || el.closest('[class*="ide-input"]')) score += 200;
        score += Math.min(80, Math.max(0, r.top));
        let selector = tag;
        if (role) selector += '[role="' + role + '"]';
        return { selector, tag, role, className: cls, visible: vis, score };
      }).sort((a, b) => b.score - a.score);
    })()`
  );
  return raw ?? [];
}

/**
 * Auto-discovers response container candidates from the live DOM.
 */
async function discoverResponseCandidates(
  cdp: BaseCdpClient,
  client: ClientDomains
): Promise<DiscoveredCandidate[]> {
  const raw = await cdp.evaluateJson<DiscoveredCandidate[]>(
    client,
    `(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 3 && r.height > 3 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const selectors = [
        '[class*="prose"]',
        '[class*="markdown"]',
        '[class*="assistant"]',
        '[class*="message-block"]',
        '[class*="composer-rendered"]',
        '[class*="anysphere-markdown"]',
        'article',
        '[role="article"]'
      ];
      const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
      const seen = new Set();
      return nodes.filter(el => {
        if (seen.has(el)) return false;
        seen.add(el);
        return true;
      }).slice(0, 15).map(el => {
        const vis = isVisible(el);
        const cls = String(el.className || '').replace(/\\s+/g, ' ').trim().substring(0, 150);
        const role = el.getAttribute('role');
        const tag = el.tagName.toLowerCase();
        const textLen = (el.textContent || '').length;
        let score = 0;
        if (vis) score += 100;
        if (textLen >= 20) score += 50;
        if (cls.includes('prose')) score += 80;
        if (cls.includes('markdown')) score += 60;
        if (cls.includes('assistant') || cls.includes('bot-color')) score += 100;
        let selector = tag;
        if (cls.includes('prose')) selector = '[class*="prose"]';
        else if (cls.includes('markdown')) selector = '[class*="markdown"]';
        return { selector, tag, role, className: cls, visible: vis, score };
      }).sort((a, b) => b.score - a.score);
    })()`
  );
  return raw ?? [];
}

/**
 * Auto-discovers mode indicator candidates from the live DOM.
 */
async function discoverModeIndicatorCandidates(
  cdp: BaseCdpClient,
  client: ClientDomains
): Promise<DiscoveredCandidate[]> {
  const modeKeywords = config.bridgeIdeTarget === "windsurf"
    ? "write|chat|plan"
    : config.bridgeIdeTarget === "vscode"
      ? "chat|ask|agent|edit|plan|debug|code"
    : "agent|code|ask|debug|plan";
  const raw = await cdp.evaluateJson<DiscoveredCandidate[]>(
    client,
    `(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 3 && r.height > 3 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const modeRe = new RegExp('(^|\\\\b)(${modeKeywords})(\\\\b|$)', 'i');
      const elements = Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"],[data-state]'))
        .filter(isVisible)
        .filter(el => {
          const text = [el.textContent || '', el.getAttribute('aria-label') || ''].join(' ');
          return modeRe.test(text) && text.length < 60;
        });
      return elements.slice(0, 10).map(el => {
        const cls = String(el.className || '').replace(/\\s+/g, ' ').trim().substring(0, 150);
        const role = el.getAttribute('role');
        const tag = el.tagName.toLowerCase();
        const dataState = el.getAttribute('data-state');
        let score = 100;
        if (dataState) score += 50;
        if (role === 'menuitem') score += 30;
        let selector = tag;
        if (dataState !== null) selector += '[data-state]';
        return { selector, tag, role, className: cls, visible: true, score };
      }).sort((a, b) => b.score - a.score);
    })()`
  );
  return raw ?? [];
}

/**
 * Runs the full CDP preflight check for the configured IDE target.
 */
export async function runPreflightCheck(): Promise<PreflightReport> {
  const ide = config.bridgeIdeTarget as "cursor" | "windsurf" | "vscode";
  const cdpUrl =
    ide === "windsurf"
      ? config.windsurfRemoteDebugUrl
      : ide === "vscode"
        ? config.vscodeRemoteDebugUrl
        : config.cursorRemoteDebugUrl;
  const cdp = createCdpClient();
  const selectors = getConfiguredSelectors();
  const warnings: string[] = [];
  const suggestions: string[] = [];

  // --- Connectivity ---
  let reachable = false;
  let versionOk = false;
  let userAgent: string | null = null;
  let targetCount = 0;
  let pageTargetCount = 0;

  try {
    const version = await cdp.readVersionInfo();
    versionOk = Boolean(version?.webSocketDebuggerUrl);
    userAgent = version?.["User-Agent"] ?? null;
    if (!versionOk) {
      warnings.push("Version endpoint reachable but webSocketDebuggerUrl missing.");
    }
  } catch {
    warnings.push(`Cannot reach CDP version endpoint at ${cdpUrl}/json/version. Is the IDE running with --remote-debugging-port?`);
    return {
      ide,
      cdpUrl,
      connectivity: { reachable: false, versionOk: false, userAgent: null, targetCount: 0, pageTargetCount: 0 },
      selectors: {
        chatInput: { selector: selectors.chatInput, matches: 0, hasVisible: false },
        response: { selector: selectors.response, matches: 0, hasVisible: false },
        modeIndicator: { selector: selectors.mode, matches: 0, hasVisible: false }
      },
      discovery: { chatInputCandidates: [], responseCandidates: [], modeIndicatorCandidates: [] },
      warnings,
      suggestions: [
        `Launch ${ide === "windsurf" ? "Windsurf" : ide === "vscode" ? "VS Code" : "Cursor"} with: --remote-debugging-port=${ide === "windsurf" ? "9223" : ide === "vscode" ? "9224" : "9222"}`
      ]
    };
  }

  try {
    const targets = await cdp.listTargets();
    targetCount = targets.length;
    pageTargetCount = targets.filter(t => t.type === "page").length;
    reachable = targets.length > 0;
    if (pageTargetCount === 0) {
      warnings.push("No page targets found. The IDE may not have a visible window open.");
    }
  } catch {
    warnings.push("CDP target list failed.");
  }

  if (!reachable) {
    return {
      ide,
      cdpUrl,
      connectivity: { reachable, versionOk, userAgent, targetCount, pageTargetCount },
      selectors: {
        chatInput: { selector: selectors.chatInput, matches: 0, hasVisible: false },
        response: { selector: selectors.response, matches: 0, hasVisible: false },
        modeIndicator: { selector: selectors.mode, matches: 0, hasVisible: false }
      },
      discovery: { chatInputCandidates: [], responseCandidates: [], modeIndicatorCandidates: [] },
      warnings,
      suggestions
    };
  }

  // --- Selector validation + discovery ---
  let chatInputProbe: SelectorProbeResult = { selector: selectors.chatInput, matches: 0, hasVisible: false };
  let responseProbe: SelectorProbeResult = { selector: selectors.response, matches: 0, hasVisible: false };
  let modeProbe: SelectorProbeResult = { selector: selectors.mode, matches: 0, hasVisible: false };
  let chatInputCandidates: DiscoveredCandidate[] = [];
  let responseCandidates: DiscoveredCandidate[] = [];
  let modeIndicatorCandidates: DiscoveredCandidate[] = [];

  try {
    await cdp.withClient(async (client) => {
      // Probe configured selectors
      chatInputProbe = await probeSelector(cdp, client, selectors.chatInput);
      responseProbe = await probeSelector(cdp, client, selectors.response);
      if (selectors.mode) {
        modeProbe = await probeSelector(cdp, client, selectors.mode);
      }

      // Auto-discover candidates
      chatInputCandidates = await discoverChatInputCandidates(cdp, client);
      responseCandidates = await discoverResponseCandidates(cdp, client);
      modeIndicatorCandidates = await discoverModeIndicatorCandidates(cdp, client);
    });
  } catch {
    warnings.push("Selector probing failed during CDP evaluation.");
  }

  // --- Analyze results and generate warnings/suggestions ---
  if (chatInputProbe.matches === 0 || !chatInputProbe.hasVisible) {
    warnings.push(`Chat input selector "${selectors.chatInput}" matched ${chatInputProbe.matches} elements (${chatInputProbe.hasVisible ? "visible" : "none visible"}).`);
    const best = chatInputCandidates.find(c => c.visible && c.score > 0);
    if (best) {
      suggestions.push(`Suggested chat input selector: ${best.selector} (class="${best.className.substring(0, 80)}")`);
    } else {
      suggestions.push("No visible chat input candidates found. Ensure the Cascade/Composer panel is open.");
    }
  }

  if (responseProbe.matches === 0) {
    // Response selector having 0 matches is only a warning if there are no messages yet
    const hasAnyResponses = responseCandidates.some(c => c.visible);
    if (hasAnyResponses) {
      warnings.push(`Response selector "${selectors.response}" matched 0 elements but DOM has response-like nodes.`);
      const best = responseCandidates.find(c => c.visible && c.score > 50);
      if (best) {
        suggestions.push(`Suggested response selector: ${best.selector} (class="${best.className.substring(0, 80)}")`);
      }
    }
  } else if (responseProbe.matches === -1) {
    warnings.push(`Response selector "${selectors.response}" is invalid CSS.`);
  }

  if (modeIndicatorCandidates.length === 0) {
    warnings.push("No mode indicator elements found. Mode switching may not work.");
  }

  return {
    ide,
    cdpUrl,
    connectivity: { reachable, versionOk, userAgent, targetCount, pageTargetCount },
    selectors: {
      chatInput: chatInputProbe,
      response: responseProbe,
      modeIndicator: modeProbe
    },
    discovery: { chatInputCandidates, responseCandidates, modeIndicatorCandidates },
    warnings,
    suggestions
  };
}

/**
 * Formats a preflight report as a human-readable string.
 */
export function formatPreflightReport(report: PreflightReport): string {
  const ideName = report.ide === "windsurf" ? "Windsurf" : report.ide === "vscode" ? "VS Code" : "Cursor";
  const lines: string[] = [];

  lines.push(`=== CDP Preflight Check: ${ideName} ===`);
  lines.push(`CDP URL: ${report.cdpUrl}`);
  lines.push("");

  // Connectivity
  lines.push("--- Connectivity ---");
  lines.push(`  Reachable:     ${report.connectivity.reachable ? "YES" : "NO"}`);
  lines.push(`  Version OK:    ${report.connectivity.versionOk ? "YES" : "NO"}`);
  lines.push(`  User-Agent:    ${report.connectivity.userAgent ?? "(unknown)"}`);
  lines.push(`  Targets:       ${report.connectivity.targetCount} total, ${report.connectivity.pageTargetCount} page`);
  lines.push("");

  // Selector health
  lines.push("--- Configured Selectors ---");
  const fmtProbe = (label: string, p: SelectorProbeResult) => {
    const status = p.matches > 0 && p.hasVisible ? "OK" : p.matches > 0 ? "HIDDEN" : p.matches === -1 ? "INVALID" : "BROKEN";
    return `  ${label}: ${status} (${p.matches} matches, visible=${p.hasVisible}) → ${p.selector}`;
  };
  lines.push(fmtProbe("Chat Input", report.selectors.chatInput));
  lines.push(fmtProbe("Response  ", report.selectors.response));
  if (report.selectors.modeIndicator.selector) {
    lines.push(fmtProbe("Mode      ", report.selectors.modeIndicator));
  }
  lines.push("");

  // Discovery
  if (report.discovery.chatInputCandidates.length > 0) {
    lines.push("--- Discovered Chat Input Candidates ---");
    for (const c of report.discovery.chatInputCandidates.slice(0, 5)) {
      lines.push(`  [${c.visible ? "VIS" : "HID"}] score=${c.score} ${c.selector} class="${c.className.substring(0, 60)}"`);
    }
    lines.push("");
  }

  if (report.discovery.responseCandidates.length > 0) {
    lines.push("--- Discovered Response Candidates ---");
    for (const c of report.discovery.responseCandidates.slice(0, 5)) {
      lines.push(`  [${c.visible ? "VIS" : "HID"}] score=${c.score} ${c.selector} class="${c.className.substring(0, 60)}"`);
    }
    lines.push("");
  }

  if (report.discovery.modeIndicatorCandidates.length > 0) {
    lines.push("--- Discovered Mode Indicator Candidates ---");
    for (const c of report.discovery.modeIndicatorCandidates.slice(0, 5)) {
      lines.push(`  [${c.visible ? "VIS" : "HID"}] score=${c.score} ${c.selector} class="${c.className.substring(0, 60)}"`);
    }
    lines.push("");
  }

  // Warnings
  if (report.warnings.length > 0) {
    lines.push("--- Warnings ---");
    for (const w of report.warnings) {
      lines.push(`  ⚠ ${w}`);
    }
    lines.push("");
  }

  // Suggestions
  if (report.suggestions.length > 0) {
    lines.push("--- Suggestions ---");
    for (const s of report.suggestions) {
      lines.push(`  → ${s}`);
    }
    lines.push("");
  }

  if (report.warnings.length === 0 && report.connectivity.reachable) {
    lines.push("All checks passed. Bridge is ready to use.");
  }

  return lines.join("\n");
}

/**
 * Extracts a short IDE version string from the User-Agent header.
 * e.g. "Cursor/0.48.7 ..." → "v0.48.7", "Windsurf/1.108.2 ..." → "v1.108.2"
 */
function extractIdeVersion(userAgent: string | null, ide: string): string | null {
  if (!userAgent) return null;
  const versionToken = ide === "VS Code" ? "Code" : ide;
  const pattern = new RegExp(`${versionToken}/(\\d[\\d.]+)`, "i");
  const match = userAgent.match(pattern);
  return match?.[1] ? `v${match[1]}` : null;
}

/**
 * Builds a compact, self-healing user-facing alert from a preflight report.
 * Each failure type includes a likely cause and actionable quick-fix.
 * Returns null if there are no issues worth reporting.
 */
function buildPreflightAlert(report: PreflightReport): string | null {
  const ideName = report.ide === "windsurf" ? "Windsurf" : report.ide === "vscode" ? "VS Code" : "Cursor";
  const version = extractIdeVersion(report.connectivity.userAgent, ideName);
  const versionTag = version ? ` ${version}` : "";
  const debugPort = report.ide === "windsurf" ? "9223" : report.ide === "vscode" ? "9224" : "9222";
  const lines: string[] = [];

  // --- CDP unreachable ---
  if (!report.connectivity.reachable) {
    lines.push(`\u26a0\ufe0f Bridge Alert (${ideName}): CDP unreachable at ${report.cdpUrl}`);
    lines.push(`Likely Cause: ${ideName} is not running, or was launched without --remote-debugging-port.`);
    lines.push(`Quick Fix: Restart ${ideName} with: --remote-debugging-port=${debugPort}`);
    if (report.ide === "cursor") {
      lines.push(`  Check for port conflicts if Windsurf is also running on the same port.`);
    }
    return lines.join("\n");
  }

  // --- Version endpoint issues ---
  if (!report.connectivity.versionOk) {
    lines.push(`\u26a0\ufe0f Bridge Alert (${ideName}${versionTag}): CDP version endpoint returned unexpected data.`);
    lines.push(`Likely Cause: ${ideName} update changed the debug protocol surface, or a proxy is interfering.`);
    lines.push(`Quick Fix: Verify ${report.cdpUrl}/json/version returns valid JSON with webSocketDebuggerUrl.`);
  }

  // --- No page targets ---
  if (report.connectivity.reachable && report.connectivity.pageTargetCount === 0) {
    lines.push(`\u26a0\ufe0f Bridge Alert (${ideName}${versionTag}): No page targets found.`);
    lines.push(`Likely Cause: ${ideName} window is not fully loaded or no workspace/folder is open.`);
    const panelName = report.ide === "windsurf" ? "Cascade" : report.ide === "vscode" ? "Chat" : "Composer";
    lines.push(`Quick Fix: Open a folder in ${ideName} and ensure the ${panelName} panel is visible.`);
  }

  const suppressSelectorAlerts = report.ide === "cursor";

  // --- Chat input selector broken ---
  const ci = report.selectors.chatInput;
  if (!suppressSelectorAlerts && report.connectivity.reachable && report.connectivity.pageTargetCount > 0) {
    if (ci.matches === 0 || !ci.hasVisible) {
      const statusWord = ci.matches === 0 ? "no matches" : `${ci.matches} match(es) but none visible`;
      lines.push(`\u26a0\ufe0f Bridge Alert (${ideName}${versionTag}): Selector CHAT_INPUT failed (${statusWord}).`);
      const panelName = report.ide === "windsurf" ? "Cascade" : report.ide === "vscode" ? "Chat" : "Composer";
      lines.push(`Likely Cause: ${ideName}${versionTag} update changed the ${panelName} layout.`);
      const bestInput = report.discovery.chatInputCandidates.find(c => c.visible && c.score > 0);
      if (bestInput) {
        lines.push(`Auto-Discovered: "${bestInput.selector}" (class="${bestInput.className.substring(0, 60)}", score=${bestInput.score})`);
        const envVar =
          report.ide === "windsurf"
            ? "WINDSURF_CHAT_INPUT_SELECTOR"
            : report.ide === "vscode"
              ? "VSCODE_CHAT_INPUT_SELECTOR"
              : "CURSOR_CHAT_INPUT_SELECTOR";
        lines.push(`Quick Fix: Update ${envVar} in .env, or run /diag to see all candidates.`);
      } else if (ci.matches === 0) {
        const panelName = report.ide === "windsurf" ? "Cascade" : report.ide === "vscode" ? "Chat" : "Composer";
        lines.push(`Quick Fix: Open the ${panelName} panel, then run /diag to discover new selectors.`);
      } else {
        lines.push(`Quick Fix: The panel may be scrolled or collapsed. Focus it and run /diag.`);
      }
    } else if (ci.matches === -1) {
      lines.push(`\u26a0\ufe0f Bridge Alert (${ideName}${versionTag}): CHAT_INPUT selector is invalid CSS.`);
      lines.push(`Quick Fix: Check .env for syntax errors in the selector value, then run /diag.`);
    }
  }

  // --- Response selector broken ---
  const rs = report.selectors.response;
  if (!suppressSelectorAlerts && report.connectivity.reachable && report.connectivity.pageTargetCount > 0 && rs.matches === -1) {
    lines.push(`\u26a0\ufe0f Bridge Alert (${ideName}${versionTag}): RESPONSE selector is invalid CSS.`);
    lines.push(`Quick Fix: Check .env for syntax errors in the response selector value.`);
  } else if (!suppressSelectorAlerts && report.connectivity.reachable && report.connectivity.pageTargetCount > 0 && rs.matches === 0) {
    const hasResponseNodes = report.discovery.responseCandidates.some(c => c.visible);
    if (hasResponseNodes) {
      lines.push(`\u26a0\ufe0f Bridge Alert (${ideName}${versionTag}): RESPONSE selector matched 0 elements but response-like DOM nodes exist.`);
      lines.push(`Likely Cause: ${ideName}${versionTag} update changed message rendering classes.`);
      const bestResp = report.discovery.responseCandidates.find(c => c.visible && c.score > 50);
      if (bestResp) {
        lines.push(`Auto-Discovered: "${bestResp.selector}" (class="${bestResp.className.substring(0, 60)}", score=${bestResp.score})`);
        const envVar =
          report.ide === "windsurf"
            ? "WINDSURF_RESPONSE_SELECTOR"
            : report.ide === "vscode"
              ? "VSCODE_RESPONSE_SELECTOR"
              : "CURSOR_RESPONSE_SELECTOR";
        lines.push(`Quick Fix: Update ${envVar} in .env, or run /diag to see all candidates.`);
      }
    }
  }

  // --- Mode indicator missing ---
  if (!suppressSelectorAlerts && report.connectivity.reachable && report.connectivity.pageTargetCount > 0 && report.discovery.modeIndicatorCandidates.length === 0) {
    lines.push(`\u26a0\ufe0f Bridge Alert (${ideName}${versionTag}): No mode indicator elements found.`);
    lines.push(`Likely Cause: ${ideName}${versionTag} update changed the mode switcher UI, or the panel is collapsed.`);
    const panelName = report.ide === "windsurf" ? "Cascade" : report.ide === "vscode" ? "Chat" : "Composer";
    lines.push(`Quick Fix: Open the ${panelName} panel fully. Mode switching (/mode) may not work until fixed.`);
  }

  if (lines.length === 0) {
    return null;
  }

  // Append a footer with the run-/diag reminder
  lines.push("");
  lines.push(`Run /diag anytime for a full diagnostic with auto-discovered selector candidates.`);

  return lines.join("\n");
}

/**
 * Runs preflight check and logs results. Non-blocking — always resolves.
 * Returns true if critical checks pass (CDP reachable + chat input selector valid).
 * If notifyUsers is provided, sends a compact alert to users when issues are found.
 */
export async function runStartupPreflightCheck(
  notifyUsers?: (message: string) => Promise<void>
): Promise<boolean> {
  try {
    const report = await runPreflightCheck();
    const ideName = report.ide === "windsurf" ? "Windsurf" : report.ide === "vscode" ? "VS Code" : "Cursor";

    if (!report.connectivity.reachable) {
      logger.warn(
        { ide: report.ide, cdpUrl: report.cdpUrl },
        `CDP preflight: ${ideName} is NOT reachable. Bridge will fail until IDE is launched with remote debugging.`
      );
      for (const s of report.suggestions) {
        logger.warn(`  → ${s}`);
      }
    } else if (report.warnings.length > 0) {
      logger.warn(
        { ide: report.ide, warnings: report.warnings.length },
        `CDP preflight: ${ideName} reachable but ${report.warnings.length} warning(s) found`
      );
      for (const w of report.warnings) {
        logger.warn(`  ⚠ ${w}`);
      }
      for (const s of report.suggestions) {
        logger.info(`  → ${s}`);
      }
    } else {
      logger.info(
        {
          ide: report.ide,
          targets: report.connectivity.targetCount,
          chatInputOk: report.selectors.chatInput.hasVisible,
          userAgent: report.connectivity.userAgent
        },
        `CDP preflight: ${ideName} all checks passed`
      );
    }

    // Notify users about issues via messaging platform
    const alert = buildPreflightAlert(report);
    if (alert && notifyUsers) {
      try {
        await notifyUsers(alert);
      } catch (notifyError) {
        logger.warn({ error: notifyError }, "Failed to send preflight alert to users");
      }
    }

    const chatOk = report.selectors.chatInput.matches > 0 && report.selectors.chatInput.hasVisible;
    return chatOk;
  } catch (error) {
    logger.warn({ error }, "CDP preflight check failed unexpectedly — bridge will attempt to run anyway");
    if (notifyUsers) {
      try {
        await notifyUsers("CDP preflight check failed unexpectedly. Check bridge logs for details.");
      } catch { /* best-effort */ }
    }
    return false;
  }
}
