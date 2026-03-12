import CDP from "chrome-remote-interface";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "../logger";

export interface CdpVersionInfo {
  webSocketDebuggerUrl?: string;
  "User-Agent"?: string;
  [key: string]: unknown;
}

interface CdpRuntimeResponse {
  result?: {
    type: string;
    value?: unknown;
    description?: string;
  };
  exceptionDetails?: unknown;
}

interface CdpAccessibilityNode {
  role?: { value?: string };
  name?: { value?: string };
  properties?: Array<{
    name?: string;
    value?: { value?: unknown };
  }>;
}

export interface ClientDomains {
  Runtime: {
    enable: () => Promise<void>;
    evaluate: (input: { expression: string; returnByValue?: boolean; awaitPromise?: boolean }) => Promise<CdpRuntimeResponse>;
  };
  Page: {
    enable: () => Promise<void>;
    captureScreenshot: (input?: { format?: "png" | "jpeg"; fromSurface?: boolean }) => Promise<{ data: string }>;
  };
  DOM: { enable: () => Promise<void> };
  Accessibility?: {
    enable?: () => Promise<void>;
    getFullAXTree?: () => Promise<{ nodes?: CdpAccessibilityNode[] }>;
  };
  Input: {
    dispatchKeyEvent: (input: {
      type: "keyDown" | "keyUp" | "char";
      key?: string;
      code?: string;
      windowsVirtualKeyCode?: number;
      nativeVirtualKeyCode?: number;
      text?: string;
      unmodifiedText?: string;
      modifiers?: number;
    }) => Promise<void>;
    dispatchMouseEvent: (input: { type: "mouseMoved"; x: number; y: number }) => Promise<void>;
  };
  close: () => Promise<void>;
}

export interface CdpTargetSummary {
  id: string;
  title: string;
  url: string;
  type: string;
}

export interface BaseCdpConfig {
  remoteDebugUrl: string;
  targetTitleHint: string;
}

function parseDebugEndpoint(endpoint: string): { host: string; port: number; protocol: string } {
  const parsed = new URL(endpoint);
  const host = parsed.hostname;
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  return { host, port, protocol: parsed.protocol };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BaseCdpClient {
  private static sharedSelectionByEndpoint = new Map<
    string,
    { manualTargetId: string | null; lastTargetTitle: string | null; lastTargetUrl: string | null }
  >();
  private static selectionStateLoaded = false;
  private static readonly selectionStatePath = join(process.cwd(), "artifacts", "target-selection", "cdp-target-state.json");
  protected readonly endpoint: { host: string; port: number; protocol: string };
  protected readonly remoteDebugUrl: string;
  protected readonly titleHint: string;
  private manualTargetId: string | null = null;
  private readonly endpointKey: string;

  constructor(cdpConfig: BaseCdpConfig) {
    this.remoteDebugUrl = cdpConfig.remoteDebugUrl;
    this.titleHint = cdpConfig.targetTitleHint;
    this.endpoint = parseDebugEndpoint(cdpConfig.remoteDebugUrl);
    this.endpointKey = `${this.endpoint.host}:${this.endpoint.port}:${this.titleHint.toLowerCase()}`;
  }

  async listTargets(): Promise<CdpTargetSummary[]> {
    const targets = await CDP.List({ host: this.endpoint.host, port: this.endpoint.port });
    return targets.map((target: { id: string; title: string; url: string; type: string }) => ({
      id: target.id,
      title: target.title,
      url: target.url,
      type: target.type
    }));
  }

  async listPageTargets(): Promise<CdpTargetSummary[]> {
    const targets = await this.listTargets();
    return targets.filter((target) => target.type === "page");
  }

  async setManualTargetByPageIndex(pageIndex: number): Promise<CdpTargetSummary | null> {
    await this.ensureSelectionStateLoaded();
    const pages = await this.listPageTargets();
    if (pageIndex < 0 || pageIndex >= pages.length) {
      return null;
    }
    const selected = pages.at(pageIndex) ?? null;
    if (!selected) {
      return null;
    }
    this.manualTargetId = selected.id;
    BaseCdpClient.sharedSelectionByEndpoint.set(this.endpointKey, {
      manualTargetId: selected.id,
      lastTargetTitle: selected.title || null,
      lastTargetUrl: selected.url || null
    });
    await this.persistSelectionState();
    return selected;
  }

  clearManualTarget(): void {
    this.manualTargetId = null;
    const current = BaseCdpClient.sharedSelectionByEndpoint.get(this.endpointKey);
    BaseCdpClient.sharedSelectionByEndpoint.set(this.endpointKey, {
      manualTargetId: null,
      lastTargetTitle: current?.lastTargetTitle ?? null,
      lastTargetUrl: current?.lastTargetUrl ?? null
    });
    void this.persistSelectionState();
  }

  async getSelectionState(): Promise<{
    mode: "auto" | "manual";
    manualTargetId: string | null;
    manualTargetTitle: string | null;
  }> {
    await this.ensureSelectionStateLoaded();
    const shared = BaseCdpClient.sharedSelectionByEndpoint.get(this.endpointKey);
    if (!this.manualTargetId && shared?.manualTargetId) {
      this.manualTargetId = shared.manualTargetId;
    }
    if (!this.manualTargetId) {
      return {
        mode: "auto",
        manualTargetId: null,
        manualTargetTitle: null
      };
    }

    const pages = await this.listPageTargets();
    const matched = pages.find((page) => page.id === this.manualTargetId);
    if (!matched) {
      this.manualTargetId = null;
      const current = BaseCdpClient.sharedSelectionByEndpoint.get(this.endpointKey);
      BaseCdpClient.sharedSelectionByEndpoint.set(this.endpointKey, {
        manualTargetId: null,
        lastTargetTitle: current?.lastTargetTitle ?? null,
        lastTargetUrl: current?.lastTargetUrl ?? null
      });
      await this.persistSelectionState();
      return {
        mode: "auto",
        manualTargetId: null,
        manualTargetTitle: null
      };
    }

    return {
      mode: "manual",
      manualTargetId: matched.id,
      manualTargetTitle: matched.title
    };
  }

  async withClient<T>(action: (domains: ClientDomains, target: CdpTargetSummary) => Promise<T>): Promise<T> {
    const target = await this.selectTarget();
    const client = (await CDP({
      host: this.endpoint.host,
      port: this.endpoint.port,
      target: target.id
    })) as unknown as ClientDomains;

    try {
      await Promise.all([client.Runtime.enable(), client.Page.enable(), client.DOM.enable()]);
      if (client.Accessibility?.enable) {
        await client.Accessibility.enable();
      }
      return await action(client, target);
    } finally {
      await client.close();
    }
  }

  async evaluateJson<T>(client: ClientDomains, expression: string): Promise<T | null> {
    const evaluated = await client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true
    });

    if (evaluated.exceptionDetails) {
      logger.warn({ expression }, "CDP evaluate returned exception details");
      return null;
    }

    if (!evaluated.result) {
      return null;
    }

    return (evaluated.result.value as T) ?? null;
  }

  async sendShortcut(client: ClientDomains, key: string, code: string, windowsKeyCode: number, modifiers = 0): Promise<void> {
    await client.Input.dispatchKeyEvent({
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode: windowsKeyCode,
      nativeVirtualKeyCode: windowsKeyCode,
      modifiers
    });
    await client.Input.dispatchKeyEvent({
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: windowsKeyCode,
      nativeVirtualKeyCode: windowsKeyCode,
      modifiers
    });
  }

  async sendText(client: ClientDomains, text: string): Promise<void> {
    for (const char of text) {
      await client.Input.dispatchKeyEvent({
        type: "char",
        text: char,
        unmodifiedText: char
      });
    }
  }

  async capturePng(client: ClientDomains): Promise<Buffer> {
    const screenshot = await client.Page.captureScreenshot({ format: "png", fromSurface: true });
    return Buffer.from(screenshot.data, "base64");
  }

  async hoverPoint(client: ClientDomains, x: number, y: number): Promise<void> {
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await sleep(100);
  }

  async readVersionInfo(): Promise<CdpVersionInfo | null> {
    const versionUrl = `${this.remoteDebugUrl.replace(/\/$/, "")}/json/version`;
    const response = await fetch(versionUrl);
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as CdpVersionInfo;
  }

  protected async selectTarget(): Promise<CdpTargetSummary> {
    await this.ensureSelectionStateLoaded();
    const pages = await this.listPageTargets();
    if (pages.length === 0) {
      throw new Error(`No page targets found on ${this.titleHint} remote debugging endpoint.`);
    }

    const shared = BaseCdpClient.sharedSelectionByEndpoint.get(this.endpointKey);
    if (!this.manualTargetId && shared?.manualTargetId) {
      this.manualTargetId = shared.manualTargetId;
    }

    if (this.manualTargetId) {
      const pinned = pages.find((page) => page.id === this.manualTargetId);
      if (pinned) {
        logger.debug({ target: pinned }, `Selected pinned ${this.titleHint} CDP target`);
        return pinned;
      }
      // Pinned target no longer exists (closed/reloaded).
      this.manualTargetId = null;
      BaseCdpClient.sharedSelectionByEndpoint.set(this.endpointKey, {
        manualTargetId: null,
        lastTargetTitle: shared?.lastTargetTitle ?? null,
        lastTargetUrl: shared?.lastTargetUrl ?? null
      });
      await this.persistSelectionState();
    }

    const scored = await Promise.all(
      pages.map(async (page) => ({
        page,
        score: await this.scoreTarget(page)
      }))
    );

    scored.sort((a, b) => b.score - a.score);
    const sticky = BaseCdpClient.sharedSelectionByEndpoint.get(this.endpointKey);
    const stickyMatch =
      pages.find((page) => {
        if (!sticky) return false;
        if (sticky.lastTargetUrl && page.url === sticky.lastTargetUrl) return true;
        if (sticky.lastTargetTitle && page.title === sticky.lastTargetTitle) return true;
        return false;
      }) ?? null;
    const selected = stickyMatch ?? scored[0]?.page ?? pages[0];
    if (!selected) {
      throw new Error(`No selectable ${this.titleHint} page target found.`);
    }
    BaseCdpClient.sharedSelectionByEndpoint.set(this.endpointKey, {
      manualTargetId: this.manualTargetId,
      lastTargetTitle: selected.title || null,
      lastTargetUrl: selected.url || null
    });
    await this.persistSelectionState();
    logger.debug({ selected, scored: scored.map((s) => ({ title: s.page.title, score: s.score })) }, `Selected ${this.titleHint} CDP target`);
    return selected;
  }

  protected async scoreTarget(target: CdpTargetSummary): Promise<number> {
    let score = 0;
    const title = String(target.title || "").toLowerCase();
    const hint = this.titleHint.toLowerCase();
    const fileLikeTitle = /\\.(md|txt|json|yaml|yml|ts|tsx|js|jsx|py|go|rs)\\b/.test(title);
    const settingsLikeTitle =
      title.includes("settings") ||
      title.includes("preferences") ||
      title.includes("extensions") ||
      title.includes("keybindings");

    if (title.includes(hint)) score += 8;
    if (fileLikeTitle) score -= 20;
    if (settingsLikeTitle) score -= 28;
    if (title.includes("plan") || title.includes("readme")) score -= 6;

    try {
      const client = (await CDP({
        host: this.endpoint.host,
        port: this.endpoint.port,
        target: target.id
      })) as unknown as ClientDomains;
      try {
        await client.Runtime.enable();
        const probe = await this.evaluateJson<{
          visibleInputCount: number;
          composerSignals: number;
          modeSignals: number;
          followupSignal: boolean;
          commandHints: number;
        }>(
          client,
          `
            (() => {
              const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none';
              };

              const textNodes = Array.from(document.querySelectorAll('div,span,button,[role="button"]'));
              let composerSignals = 0;
              let modeSignals = 0;
              let followupSignal = false;
              let commandHints = 0;
              for (const node of textNodes) {
                if (!isVisible(node)) continue;
                const text = String((node.textContent || '') + ' ' + (node.getAttribute('aria-label') || '')).toLowerCase();
                if (!text) continue;
                if (text.includes('add a follow-up') || text.includes('follow-up')) followupSignal = true;
                if (text.includes('agent') || text.includes('ask') || text.includes('debug') || text.includes('plan')) modeSignals += 1;
                const className = String(node.className || '').toLowerCase();
                if (className.includes('composer') || className.includes('ai-input') || className.includes('input-box') || className.includes('prose')) {
                  composerSignals += 1;
                }
              }

              const visibleInputCount = [
                ...Array.from(document.querySelectorAll('textarea')),
                ...Array.from(document.querySelectorAll('[contenteditable="true"]')),
                ...Array.from(document.querySelectorAll('[role="textbox"]'))
              ].filter(isVisible).length;

              return {
                visibleInputCount,
                composerSignals,
                modeSignals,
                followupSignal,
                commandHints
              };
            })();
          `
        );

        if (probe) {
          score += Math.min(24, probe.visibleInputCount * 8);
          score += Math.min(20, probe.composerSignals * 3);
          score += Math.min(14, probe.modeSignals);
          if (probe.followupSignal) score += 16;
          score += Math.min(12, probe.commandHints * 3);

          const hasStrongChatSignals =
            probe.followupSignal ||
            probe.commandHints >= 2 ||
            (probe.visibleInputCount > 0 && probe.composerSignals >= 3);
          if (!hasStrongChatSignals) {
            if (fileLikeTitle) score -= 40;
            if (settingsLikeTitle) score -= 42;
          }
        }
      } finally {
        await client.close();
      }
    } catch (error) {
      logger.debug({ error, targetTitle: target.title }, "Target probing failed; using title-based score");
    }

    return score;
  }

  private async ensureSelectionStateLoaded(): Promise<void> {
    if (BaseCdpClient.selectionStateLoaded) return;
    BaseCdpClient.selectionStateLoaded = true;
    try {
      const raw = await readFile(BaseCdpClient.selectionStatePath, "utf8");
      const parsed = JSON.parse(raw) as Record<
        string,
        { manualTargetId?: string | null; lastTargetTitle?: string | null; lastTargetUrl?: string | null }
      >;
      for (const [key, value] of Object.entries(parsed || {})) {
        BaseCdpClient.sharedSelectionByEndpoint.set(key, {
          manualTargetId: typeof value?.manualTargetId === "string" ? value.manualTargetId : null,
          lastTargetTitle: typeof value?.lastTargetTitle === "string" ? value.lastTargetTitle : null,
          lastTargetUrl: typeof value?.lastTargetUrl === "string" ? value.lastTargetUrl : null
        });
      }
    } catch {
      // best-effort cache load
    }
  }

  private async persistSelectionState(): Promise<void> {
    try {
      const out: Record<string, { manualTargetId: string | null; lastTargetTitle: string | null; lastTargetUrl: string | null }> =
        {};
      for (const [key, value] of BaseCdpClient.sharedSelectionByEndpoint.entries()) {
        out[key] = value;
      }
      await mkdir(dirname(BaseCdpClient.selectionStatePath), { recursive: true });
      await writeFile(BaseCdpClient.selectionStatePath, JSON.stringify(out, null, 2), "utf8");
    } catch (error) {
      logger.debug({ error }, "Failed to persist CDP target state");
    }
  }
}

export async function wait(ms: number): Promise<void> {
  await sleep(ms);
}
