import { exec } from "node:child_process";
import { promisify } from "node:util";
import { BridgeMode, BridgeResponse } from "../types";
import { logger } from "../logger";
import { config } from "../config";
import { ClientDomains, CursorCdpClient, CursorTargetSummary, wait } from "./CursorCdpClient";

const execAsync = promisify(exec);
type DetectedMode = "Agent" | "Code" | "Ask" | "Debug" | "Plan";

/**
 * Cursor integration status:
 * - mode switching shortcuts: official behavior in Cursor docs
 * - direct UI automation shelling: best-effort fallback
 */
export class CursorAutomationClient {
  private readonly cdp = new CursorCdpClient();
  private readonly modeLabelAliases: Record<BridgeMode, string[]> = {
    ask: ["Ask"],
    code: ["Agent", "Code"],
    plan: ["Plan"],
    debug: ["Debug"]
  };

  async listChatTargets(): Promise<CursorTargetSummary[]> {
    try {
      return await this.cdp.listTargets();
    } catch (error) {
      logger.warn({ error }, "Failed to list Cursor targets through CDP");
      return [];
    }
  }

  private async sampleDomMarkers(client: ClientDomains): Promise<{
    chat: { tag: string; role: string | null; cls: string }[];
    response: { tag: string; role: string | null; cls: string }[];
  }> {
    const expression = `
      (() => {
        const isVis = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 3 && r.height > 3 && s.visibility !== 'hidden' && s.display !== 'none';
        };

        const topN = (arr, n = 5) => arr.slice(0, n);

        const chat = Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]'))
          .filter(isVis)
          .map((el) => ({
            tag: (el.tagName || '').toLowerCase(),
            role: el.getAttribute('role'),
            cls: String(el.className || '').replace(/\s+/g, ' ').trim().slice(0, 200)
          }));

        const resp = Array.from(document.querySelectorAll('[class*="prose"],[class*="markdown"],[class*="assistant"],[class*="message"],article,[role="article"],.composer-rendered-message,.anysphere-markdown-container-root'))
          .filter(isVis)
          .map((el) => ({
            tag: (el.tagName || '').toLowerCase(),
            role: el.getAttribute('role'),
            cls: String(el.className || '').replace(/\s+/g, ' ').trim().slice(0, 200)
          }));

        return { chat: topN(chat), response: topN(resp) };
      })();
    `;

    const result = await this.cdp.evaluateJson<{
      chat: { tag: string; role: string | null; cls: string }[];
      response: { tag: string; role: string | null; cls: string }[];
    }>(client, expression);

    return {
      chat: result?.chat ?? [],
      response: result?.response ?? []
    };
  }

  async targetSelectionStatus(): Promise<{
    mode: "auto" | "manual";
    manualTargetId: string | null;
    manualTargetTitle: string | null;
  }> {
    try {
      return await this.cdp.getSelectionState();
    } catch (error) {
      logger.warn({ error }, "Failed to read target selection state");
      return {
        mode: "auto",
        manualTargetId: null,
        manualTargetTitle: null
      };
    }
  }

  async selectTarget(selection: "auto" | number): Promise<BridgeResponse> {
    if (selection === "auto") {
      this.cdp.clearManualTarget();
      return {
        text: "Target selection set to auto.",
        metadata: { target_mode: "auto" }
      };
    }

    const target = await this.cdp.setManualTargetByPageIndex(selection - 1);
    if (!target) {
      const pages = await this.cdp.listPageTargets();
      return {
        text: `Invalid target index ${selection}. Use /targets to list valid indices (1-${pages.length}).`,
        metadata: { target_mode: "manual", status: "invalid-index" }
      };
    }

    return {
      text: `Pinned target #${selection}: ${target.title || "(untitled)"}`,
      metadata: { target_mode: "manual", target_id: target.id, target_title: target.title }
    };
  }

  async setMode(mode: BridgeMode): Promise<BridgeResponse> {
    const aliases = this.modeLabelAliases[mode];

    logger.info({ mode }, "Requested mode switch");

    try {
      const switched = await this.cdp.withClient(async (client): Promise<{ ok: boolean; detectedMode: string | null }> => {
        const preCandidates = await this.readModeCandidates(client);
        const focused = await this.focusChatInput(client);
        if (!focused) {
          logger.info({ mode, preCandidates }, "Mode switch: chat input not focusable");
          return { ok: false, detectedMode: null };
        }

        const initialMode = await this.detectCurrentMode(client);
        logger.info({ mode, initialMode, preCandidates }, "Mode switch: initial detection");
        if (initialMode && aliases.includes(initialMode)) {
          return { ok: true, detectedMode: initialMode };
        }

        // Prefer deterministic click on matching mode button labels.
        const clicked = await this.clickModeButton(client, aliases);
        if (clicked) {
          await wait(180);
          const afterClickMode = await this.detectCurrentMode(client);
          const postCandidates = await this.readModeCandidates(client);
          logger.info(
            { mode, aliases, clicked, afterClickMode, postCandidates },
            "Mode switch: click attempt result"
          );
          if (afterClickMode && aliases.includes(afterClickMode)) {
            return { ok: true, detectedMode: afterClickMode };
          }
          // If click changed to a different known mode, avoid extra rotations.
          if (afterClickMode && initialMode && afterClickMode !== initialMode) {
            return { ok: false, detectedMode: afterClickMode };
          }
          // If click did not change mode (or detection is unavailable), proceed to
          // keyboard fallback for deterministic progression.
        }

        const fallbackMode = await this.detectCurrentMode(client);
        logger.info({ mode, fallbackMode }, "Mode switch: keyboard fallback check");
        if (fallbackMode) {
          // Verified-mode fallback: rotate only while detection exists.
          for (let attempt = 0; attempt < 8; attempt += 1) {
            await this.cdp.sendShortcut(client, "Tab", "Tab", 9, 8);
            await wait(180);
            const currentMode = await this.detectCurrentMode(client);
            logger.info({ mode, attempt: attempt + 1, currentMode }, "Mode switch: keyboard rotation step");
            if (currentMode && aliases.includes(currentMode)) {
              return { ok: true, detectedMode: currentMode };
            }
            if (!currentMode) {
              // If detection disappears mid-loop, stop to avoid cycling back.
              break;
            }
          }
          return { ok: false, detectedMode: await this.detectCurrentMode(client) };
        }

        // Last-resort: single-step rotate only once when mode cannot be detected.
        // This avoids accidental full-cycle wraparound back to the original mode.
        await this.cdp.sendShortcut(client, "Tab", "Tab", 9, 8);
        await wait(180);
        const finalDetected = await this.detectCurrentMode(client);
        logger.info({ mode, finalDetected }, "Mode switch: last-resort single rotation");
        return { ok: false, detectedMode: finalDetected };
      });

      if (!switched.ok) {
        return {
          text: `Mode switch could not be verified for ${mode}. Current detected mode: ${switched.detectedMode ?? "unknown"}.`,
          metadata: {
            mapped_to: aliases.join("/"),
            detected_mode: switched.detectedMode,
            status: "unverified"
          }
        };
      }

      return {
        text: `Mode switched: ${mode} -> ${switched.detectedMode ?? aliases[0]}.`,
        metadata: {
          mapped_to: aliases.join("/"),
          detected_mode: switched.detectedMode,
          status: "verified"
        }
      };
    } catch (error) {
      logger.warn({ error, mode }, "CDP mode switching failed");
      return {
        text: `Mode switch failed through CDP for ${mode}.`,
        metadata: { mapped_to: aliases.join("/"), status: "failed" }
      };
    }
  }

  async sendPrompt(
    prompt: string,
    options?: { preferAttachmentComposer?: boolean; attachmentKind?: "photo" | "document"; attachmentFileName?: string }
  ): Promise<BridgeResponse> {
    logger.info({ length: prompt.length }, "Prompt relay requested");

    try {
      const relayResult = await this.cdp.withClient(async (client) => {
        const focusOptions: {
          preferAttachmentComposer?: boolean;
          attachmentKind?: "photo" | "document";
          attachmentFileName?: string;
        } = {
          preferAttachmentComposer: options?.preferAttachmentComposer === true
        };
        if (options?.attachmentKind) {
          focusOptions.attachmentKind = options.attachmentKind;
        }
        if (options?.attachmentFileName) {
          focusOptions.attachmentFileName = options.attachmentFileName;
        }
        const focused = await this.focusChatInput(client, focusOptions);
        if (!focused) {
          return { delivered: false, responseSnippet: null as string | null };
        }

        const baselineSnippet = await this.readLatestAssistantSnippet(client);
        const injected = await this.injectPromptText(client, prompt);
        if (!injected) {
          return { delivered: false, responseSnippet: null as string | null };
        }

        await this.cdp.sendShortcut(client, "Enter", "Enter", 13, 0);
        const responseSnippet = await this.pollLatestAssistantSnippet(client, config.cursorActionTimeoutMs, baselineSnippet);
        return { delivered: true, responseSnippet };
      });

      if (!relayResult.delivered) {
        return {
          text: "Prompt relay failed: chat input could not be focused or text injection failed.",
          metadata: { status: "failed" }
        };
      }

      if (relayResult.responseSnippet) {
        return {
          text: relayResult.responseSnippet,
          metadata: { status: "delivered" }
        };
      }

      return {
        text:
          "Prompt delivered, but response capture is still pending.\n" +
          "Try /diag and resend if no reply appears shortly.",
        metadata: { status: "delivered-no-snippet" }
      };
    } catch (error) {
      logger.warn({ error }, "CDP prompt relay failed");
      return {
        text: "Prompt relay failed through CDP. Check remote debugging endpoint and target selection.",
        metadata: { status: "failed" }
      };
    }
  }

  async latestAssistantSnippet(): Promise<string | null> {
    try {
      return await this.cdp.withClient(async (client) => {
        return await this.readLatestAssistantSnippet(client);
      });
    } catch (error) {
      logger.warn({ error }, "Failed reading latest assistant snippet");
      return null;
    }
  }

  async getModel(): Promise<BridgeResponse> {
    try {
      const model = await this.cdp.withClient(async (client) => {
        return await this.detectCurrentModel(client);
      });
      if (model) {
        return { text: `Current model: ${model}`, metadata: { model, status: "detected" } };
      }
      return { text: "Could not detect current model.", metadata: { status: "undetected" } };
    } catch (error) {
      logger.warn({ error }, "CDP model detection failed");
      return { text: "Model detection failed through CDP.", metadata: { status: "failed" } };
    }
  }

  async setModel(modelName: string): Promise<BridgeResponse> {
    try {
      const result = await this.cdp.withClient(async (client) => {
        return await this.clickModelOption(client, modelName);
      });
      if (result.ok) {
        return {
          text: `Model switched to: ${result.selectedModel ?? modelName}`,
          metadata: { model: result.selectedModel, status: "switched" }
        };
      }
      return {
        text: `Could not switch to model "${modelName}". Current: ${result.selectedModel ?? "unknown"}. Use /model to see current model.`,
        metadata: { model: result.selectedModel, status: "not-found" }
      };
    } catch (error) {
      logger.warn({ error, modelName }, "CDP model switching failed");
      return { text: `Model switch failed through CDP for "${modelName}".`, metadata: { status: "failed" } };
    }
  }

  async newChat(): Promise<BridgeResponse> {
    // Ctrl+Shift+L / Cmd+Shift+L maps to new chat in current Cursor builds.
    try {
      const result = await this.cdp.withClient(async (client) => {
        const isMac = process.platform === "darwin";
        const modifiers = isMac ? 12 /* Meta+Shift */ : 10 /* Ctrl+Shift */;
        await this.cdp.sendShortcut(client, "l", "KeyL", 76, modifiers);
        await wait(240);
        const focused = await this.focusChatInput(client);
        let cleared = await this.clearChatInput(client);
        if (!cleared) {
          await wait(80);
          if (!focused) {
            await this.focusChatInput(client);
          }
          cleared = await this.clearChatInput(client);
        }
        return { cleared, focused };
      });

      if (result.cleared) {
        return {
          text: "New chat shortcut dispatched through CDP and composer cleared.",
          metadata: { status: "dispatched-cdp-cleared", focused: result.focused }
        };
      }

      // Fallback: send OS keys and try again
      await execAsync(
        "powershell -NoProfile -Command \"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^+l')\""
      );
      await wait(260);
      const focused = await this.cdp.withClient(async (client) => this.focusChatInput(client));
      const cleared = await this.cdp.withClient(async (client) => this.clearChatInput(client));
      return {
        text: cleared
          ? "New chat shortcut dispatched (CDP + OS) and composer cleared."
          : "New chat shortcut dispatched (CDP + OS). Composer focus/clear not verified.",
        metadata: { status: cleared ? "dispatched-os-cleared" : "dispatched-os", focused }
      };
    } catch (error) {
      logger.warn({ error }, "New chat shortcut dispatch failed");
      return { text: "New chat dispatch failed; manual fallback required.", metadata: { status: "failed" } };
    }
  }

  async diagnostics(): Promise<{
    cdpReachable: boolean;
    versionEndpointReachable: boolean;
    targetCount: number;
    pageTargetCount: number;
    selectedTargetTitle: string | null;
    chatInputFocusable: boolean | null;
    detectedMode: DetectedMode | null;
    configuredSelectors: {
      chatInput: string;
      response: string;
      context: string;
    };
    targetSelection: {
      mode: "auto" | "manual";
      manualTargetId: string | null;
      manualTargetTitle: string | null;
    };
    notes: string[];
    selectorHealth: {
      configuredChatInputMatches: number;
      configuredResponseMatches: number;
      configuredContextMatches: number;
      fallbackTextboxCandidates: number;
      fallbackResponseCandidates: number;
    };
  }> {
    const notes: string[] = [];
    const configuredSelectors = {
      chatInput: config.cursorChatInputSelector,
      response: config.cursorResponseSelector,
      context: config.cursorContextSelector
    };

    let versionEndpointReachable = false;
    try {
      const version = await this.cdp.readVersionInfo();
      versionEndpointReachable = Boolean(version?.webSocketDebuggerUrl);
      if (!versionEndpointReachable) {
        notes.push("Version endpoint reachable but webSocketDebuggerUrl missing.");
      }
    } catch (error) {
      logger.warn({ error }, "CDP version endpoint check failed");
      notes.push("Version endpoint check failed.");
    }

    try {
      const targetSelection = await this.cdp.getSelectionState();
      const targets = await this.listChatTargets();
      const pageTargets = targets.filter((target) => target.type === "page");
      if (targets.length === 0) {
        return {
          cdpReachable: false,
          versionEndpointReachable,
          targetCount: 0,
          pageTargetCount: 0,
          selectedTargetTitle: null,
          chatInputFocusable: null,
          detectedMode: null,
          configuredSelectors,
          targetSelection,
          notes: [...notes, "No targets discovered."],
          selectorHealth: {
            configuredChatInputMatches: 0,
            configuredResponseMatches: 0,
            configuredContextMatches: 0,
            fallbackTextboxCandidates: 0,
            fallbackResponseCandidates: 0
          }
        };
      }

      const runtimeCheck = await this.cdp.withClient(async (client, target) => {
        const focusable = await this.focusChatInput(client);
        const mode = await this.detectCurrentMode(client);
        const modeCandidates = await this.readModeCandidates(client);
        const selectorHealth = await this.readSelectorHealth(client);
        const samples = await this.sampleDomMarkers(client);
        return {
          selectedTargetTitle: target.title,
          chatInputFocusable: focusable,
          detectedMode: mode,
          modeCandidates,
          selectorHealth,
          samples
        };
      });

      if (runtimeCheck.modeCandidates.length > 0) {
        notes.push(`Mode candidates: ${runtimeCheck.modeCandidates.join(" | ")}`);
      }

      if (runtimeCheck.samples.chat.length > 0) {
        const rendered = runtimeCheck.samples.chat
          .map((c) => `${c.tag}${c.role ? `[${c.role}]` : ""} class="${c.cls}"`)
          .join(" | ");
        notes.push(`Chat samples: ${rendered}`);
      }

      if (runtimeCheck.samples.response.length > 0) {
        const rendered = runtimeCheck.samples.response
          .map((c) => `${c.tag}${c.role ? `[${c.role}]` : ""} class="${c.cls}"`)
          .join(" | ");
        notes.push(`Response samples: ${rendered}`);
      }

      return {
        cdpReachable: true,
        versionEndpointReachable,
        targetCount: targets.length,
        pageTargetCount: pageTargets.length,
        selectedTargetTitle: runtimeCheck.selectedTargetTitle,
        chatInputFocusable: runtimeCheck.chatInputFocusable,
        detectedMode: runtimeCheck.detectedMode,
        configuredSelectors,
        targetSelection,
        notes,
        selectorHealth: runtimeCheck.selectorHealth
      };
    } catch (error) {
      logger.warn({ error }, "CDP runtime diagnostics failed");
      return {
        cdpReachable: false,
        versionEndpointReachable,
        targetCount: 0,
        pageTargetCount: 0,
        selectedTargetTitle: null,
        chatInputFocusable: null,
        detectedMode: null,
        configuredSelectors,
        targetSelection: {
          mode: "auto",
          manualTargetId: null,
          manualTargetTitle: null
        },
        notes: [...notes, "Runtime diagnostics failed."],
        selectorHealth: {
          configuredChatInputMatches: 0,
          configuredResponseMatches: 0,
          configuredContextMatches: 0,
          fallbackTextboxCandidates: 0,
          fallbackResponseCandidates: 0
        }
      };
    }
  }

  private async readSelectorHealth(client: ClientDomains): Promise<{
    configuredChatInputMatches: number;
    configuredResponseMatches: number;
    configuredContextMatches: number;
    fallbackTextboxCandidates: number;
    fallbackResponseCandidates: number;
  }> {
    const expression = `
      (() => {
        const configuredChat = ${JSON.stringify(config.cursorChatInputSelector)};
        const configuredResp = ${JSON.stringify(config.cursorResponseSelector)};
        const configuredCtx = ${JSON.stringify(config.cursorContextSelector)};
        const count = (sel) => {
          if (!sel) return 0;
          try {
            return document.querySelectorAll(sel).length;
          } catch (_error) {
            return -1;
          }
        };
        const fallbackTextbox = document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]').length;
        const fallbackResponse = document.querySelectorAll(
          '[data-role*="assistant"],[class*="assistant"],[data-testid*="assistant"],.composer-rendered-message,.anysphere-markdown-container-root,article,[role="article"],.message'
        ).length;
        return {
          configuredChatInputMatches: count(configuredChat),
          configuredResponseMatches: count(configuredResp),
          configuredContextMatches: count(configuredCtx),
          fallbackTextboxCandidates: fallbackTextbox,
          fallbackResponseCandidates: fallbackResponse
        };
      })();
    `;
    const result = await this.cdp.evaluateJson<{
      configuredChatInputMatches: number;
      configuredResponseMatches: number;
      configuredContextMatches: number;
      fallbackTextboxCandidates: number;
      fallbackResponseCandidates: number;
    }>(client, expression);
    return {
      configuredChatInputMatches: Number(result?.configuredChatInputMatches ?? 0),
      configuredResponseMatches: Number(result?.configuredResponseMatches ?? 0),
      configuredContextMatches: Number(result?.configuredContextMatches ?? 0),
      fallbackTextboxCandidates: Number(result?.fallbackTextboxCandidates ?? 0),
      fallbackResponseCandidates: Number(result?.fallbackResponseCandidates ?? 0)
    };
  }

  private async focusChatInput(
    client: ClientDomains,
    options?: { preferAttachmentComposer?: boolean; attachmentKind?: "photo" | "document"; attachmentFileName?: string }
  ): Promise<boolean> {
    const selectorLiteral = JSON.stringify(config.cursorChatInputSelector);
    const preferAttachmentComposerLiteral = JSON.stringify(options?.preferAttachmentComposer === true);
    const attachmentKindLiteral = JSON.stringify(options?.attachmentKind ?? "document");
    const attachmentFileNameLiteral = JSON.stringify(String(options?.attachmentFileName ?? "").toLowerCase());
    const expression = `
      (() => {
        function isVisible(el) {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
        }

        const configured = ${selectorLiteral};
        if (configured) {
          const explicit = document.querySelector(configured);
          if (explicit && isVisible(explicit)) {
            explicit.focus();
            return true;
          }
        }

        const candidates = [
          ...Array.from(document.querySelectorAll('textarea')),
          ...Array.from(document.querySelectorAll('[contenteditable="true"]')),
          ...Array.from(document.querySelectorAll('[role="textbox"]'))
        ].filter(isVisible);

        if (candidates.length === 0) return false;

        const attachmentSelectorsFor = (kind) => {
          if (kind === 'photo') {
            return [
              'img',
              '[class*="image"]',
              '[class*="attachment"]',
              '[class*="upload"]',
              '[data-testid*="image"]',
              '[data-testid*="attachment"]'
            ];
          }
          return [
            '[class*="file"]',
            '[class*="document"]',
            '[class*="attachment"]',
            '[class*="upload"]',
            '[data-testid*="file"]',
            '[data-testid*="attachment"]'
          ];
        };
        const attachmentFileName = ${attachmentFileNameLiteral};
        const attachmentFileStem = attachmentFileName.replace(/\\.[^\\.]+$/, '');
        const countAttachmentSignals = (root, kind) => {
          if (!root) return 0;
          let total = 0;
          for (const sel of attachmentSelectorsFor(kind)) {
            total += root.querySelectorAll(sel).length;
          }
          return total;
        };

        const score = (el) => {
          const rect = el.getBoundingClientRect();
          const className = String(el.className || '').toLowerCase();
          const placeholder = String(el.getAttribute('placeholder') || '').toLowerCase();
          const ariaLabel = String(el.getAttribute('aria-label') || '').toLowerCase();
          let value = 0;
          if (el.closest('[class*="composer"],[class*="ai-input"],[class*="input-box"]')) value += 300;
          if (className.includes('composer') || className.includes('ai-input') || className.includes('input-box')) value += 200;
          if (placeholder.includes('follow-up') || placeholder.includes('message') || ariaLabel.includes('follow-up')) value += 180;
          if (el.getAttribute('role') === 'textbox') value += 40;
          if (${preferAttachmentComposerLiteral}) {
            const root = el.closest('[class*="composer"],[class*="ai-input"],[class*="input-box"]') || el.parentElement;
            const attachmentSignals = countAttachmentSignals(root, ${attachmentKindLiteral});
            value += Math.min(360, attachmentSignals * 80);
            if (root && attachmentFileName.length >= 4) {
              const rootText = String(root.innerText || '').toLowerCase();
              if (rootText.includes(attachmentFileName)) {
                value += 500;
              } else if (attachmentFileStem.length >= 4 && rootText.includes(attachmentFileStem)) {
                value += 300;
              }
            }
          }
          // Prefer elements lower in the viewport (chat composer area).
          value += Math.min(180, Math.max(0, rect.top));
          // Penalize huge editor/text areas.
          value -= Math.min(220, Math.round((rect.width * rect.height) / 4000));
          return value;
        };

        candidates.sort((a, b) => {
          const diff = score(b) - score(a);
          if (diff !== 0) return diff;
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return br.top - ar.top;
        });

        candidates[0].focus();
        return document.activeElement === candidates[0];
      })();
    `;

    const focused = await this.cdp.evaluateJson<boolean>(client, expression);
    return focused === true;
  }

  private async clearChatInput(client: ClientDomains): Promise<boolean> {
    const expression = `
      (() => {
        try {
          const el = document.activeElement as HTMLElement | null;
          if (!el) return false;

          const dispatch = (target, type) => target.dispatchEvent(new Event(type, { bubbles: true }));

          if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
            el.value = "";
            dispatch(el, "input");
            dispatch(el, "change");
            return true;
          }

          if (el.getAttribute && el.getAttribute("contenteditable") === "true") {
            el.textContent = "";
            const InputEvt = typeof InputEvent === "function" ? InputEvent : Event;
            el.dispatchEvent(new InputEvt("input", { bubbles: true, data: "", inputType: "deleteContent" }));
            return true;
          }

          return false;
        } catch (_err) {
          return false;
        }
      })();
    `;

    const cleared = await this.cdp.evaluateJson<boolean>(client, expression);
    return cleared === true;
  }

  private async detectCurrentMode(client: ClientDomains): Promise<DetectedMode | null> {
    const domDetected = await this.detectCurrentModeFromDom(client);
    if (domDetected) {
      return domDetected;
    }
    return await this.detectCurrentModeFromAccessibility(client);
  }

  private async detectCurrentModeFromDom(client: ClientDomains): Promise<DetectedMode | null> {
    const expression = `
      (() => {
        const modeMatchers = [
          { label: 'Agent', key: 'agent' },
          { label: 'Ask', key: 'ask' },
          { label: 'Debug', key: 'debug' },
          { label: 'Plan', key: 'plan' },
          { label: 'Code', key: 'code' }
        ];

        const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        const modeFromText = (textValue) => {
          const text = normalize(textValue);
          if (!text) return null;
          for (const mode of modeMatchers) {
            const re = new RegExp('(^|\\\\b)' + mode.key + '(\\\\b|$)');
            if (re.test(text)) return mode.label;
          }
          return null;
        };

        // Primary signal in current Cursor builds: unified mode chip near composer.
        const dropdowns = Array.from(document.querySelectorAll('[class*="composer-unified-dropdown"]'));
        for (const dropdown of dropdowns) {
          const text = [
            dropdown.textContent || '',
            dropdown.getAttribute('aria-label') || '',
            dropdown.getAttribute('title') || ''
          ].join(' ');
          const mode = modeFromText(text);
          if (mode) return mode;
        }

        const buttons = Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"]'));
        const parsed = buttons.map((button) => {
          const text = [
            button.textContent || '',
            button.getAttribute('aria-label') || '',
            button.getAttribute('title') || ''
          ].join(' ');
          const mode = modeFromText(text);
          if (!mode) return null;

          const className = normalize(button.className || '');
          const pressed = normalize(button.getAttribute('aria-pressed') || '');
          const selectedByAttr =
            pressed === 'true' ||
            normalize(button.getAttribute('data-state') || '') === 'active' ||
            normalize(button.getAttribute('data-state') || '') === 'selected' ||
            normalize(button.getAttribute('aria-current') || '') === 'true';
          const selectedByClass =
            className.includes('selected') ||
            className.includes('active') ||
            className.includes('current') ||
            className.includes('checked');

          return { button, mode, selectedByAttr, selectedByClass };
        }).filter(Boolean);

        if (parsed.length === 0) return null;

        // Prefer a sibling cluster that contains 3+ distinct modes.
        const groups = new Map();
        for (const item of parsed) {
          const key = item.button.parentElement || item.button;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(item);
        }
        const clustered = Array.from(groups.values()).filter((group) => {
          const unique = new Set(group.map((item) => item.mode));
          return unique.size >= 3;
        });
        const scope = clustered.length > 0 ? clustered.sort((a, b) => b.length - a.length)[0] : parsed;

        const attrSelected = scope.find((item) => item.selectedByAttr);
        if (attrSelected) return attrSelected.mode;

        const classSelected = scope.find((item) => item.selectedByClass);
        if (classSelected) return classSelected.mode;

        return null;
      })();
    `;
    return await this.cdp.evaluateJson<DetectedMode | null>(client, expression);
  }

  private async clickModeButton(client: ClientDomains, preferredLabels: string[]): Promise<boolean> {
    const labelsLiteral = JSON.stringify(preferredLabels);
    const expression = `
      (() => {
        const preferred = ${labelsLiteral}.map((x) => String(x || '').toLowerCase());
        const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        const modeMatchers = [
          { label: 'agent', key: 'agent' },
          { label: 'ask', key: 'ask' },
          { label: 'debug', key: 'debug' },
          { label: 'plan', key: 'plan' },
          { label: 'code', key: 'code' }
        ];
        const modeFromText = (textValue) => {
          const text = normalize(textValue);
          if (!text) return null;
          for (const mode of modeMatchers) {
            const re = new RegExp('(^|\\\\b)' + mode.key + '(\\\\b|$)');
            if (re.test(text)) return mode.label;
          }
          return null;
        };
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
        };

        const buttons = Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"]'));
        const dropdowns = Array.from(document.querySelectorAll('[class*="composer-unified-dropdown"]')).filter((el) => isVisible(el));
        for (const dropdown of dropdowns) {
          const dropdownText = normalize([
            dropdown.textContent || '',
            dropdown.getAttribute('aria-label') || '',
            dropdown.getAttribute('title') || ''
          ].join(' '));
          const currentMode = modeFromText(dropdownText);
          if (currentMode && preferred.includes(currentMode)) {
            return true;
          }

          dropdown.click();
          const dr = dropdown.getBoundingClientRect();
          const optionNodes = Array.from(
            document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],div,span,a')
          ).filter((el) => isVisible(el));
          const options = optionNodes
            .map((el) => {
              const text = normalize([
                el.textContent || '',
                el.getAttribute('aria-label') || '',
                el.getAttribute('title') || ''
              ].join(' '));
              const mode = modeFromText(text);
              if (!mode) return null;
              const er = el.getBoundingClientRect();
              const near = Math.abs(er.left - dr.left) <= 420 && Math.abs(er.top - dr.top) <= 520;
              if (!near) return null;
              return { el, mode, tag: (el.tagName || '').toLowerCase(), role: normalize(el.getAttribute('role') || '') };
            })
            .filter(Boolean);

          for (const preferredLabel of preferred) {
            const hit = options.find((option) => option.mode === preferredLabel && (option.role || option.tag === 'button'));
            if (hit) {
              hit.el.click();
              return true;
            }
          }
          for (const preferredLabel of preferred) {
            const hit = options.find((option) => option.mode === preferredLabel);
            if (hit) {
              hit.el.click();
              return true;
            }
          }
        }

        const entries = buttons.map((button) => {
          const text = normalize([
            button.textContent || '',
            button.getAttribute('aria-label') || '',
            button.getAttribute('title') || ''
          ].join(' '));
          return {
            button,
            text,
            mode: modeFromText(text)
          };
        }).filter((entry) => entry.mode && isVisible(entry.button));

        const groups = new Map();
        for (const entry of entries) {
          const key = entry.button.parentElement || entry.button;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(entry);
        }
        const clustered = Array.from(groups.values()).filter((group) => {
          const unique = new Set(group.map((entry) => entry.mode));
          return unique.size >= 3;
        });
        const scope = clustered.length > 0 ? clustered.sort((a, b) => b.length - a.length)[0] : entries;

        for (const preferredLabel of preferred) {
          const hit = scope.find((entry) => entry.mode === preferredLabel);
          if (hit) {
            hit.button.click();
            return true;
          }
        }

        return false;
      })();
    `;
    return (await this.cdp.evaluateJson<boolean>(client, expression)) === true;
  }

  private async readModeCandidates(client: ClientDomains): Promise<string[]> {
    const domCandidatesExpression = `
      (() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const hasModeWord = (text) => /(^|\\b)(agent|ask|debug|plan|code)(\\b|$)/i.test(text);
        const nodes = Array.from(
          document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],[class*="composer-unified-dropdown"]')
        );
        const rows = nodes
          .filter((node) => isVisible(node))
          .map((node) => {
            const text = normalize([
              node.textContent || '',
              node.getAttribute('aria-label') || '',
              node.getAttribute('title') || ''
            ].join(' '));
            if (!text || !hasModeWord(text)) return null;
            const className = normalize(node.className || '');
            const pressed = normalize(node.getAttribute('aria-pressed') || '');
            const selected =
              pressed === 'true' ||
              normalize(node.getAttribute('data-state') || '') === 'active' ||
              normalize(node.getAttribute('data-state') || '') === 'selected' ||
              normalize(node.getAttribute('aria-current') || '') === 'true' ||
              className.includes('selected') ||
              className.includes('active') ||
              className.includes('current') ||
              className.includes('checked');
            return (selected ? '[*]' : '[ ]') + ' [DOM] ' + text;
          })
          .filter(Boolean);
        return rows.slice(0, 30);
      })();
    `;
    const domCandidates = await this.cdp.evaluateJson<string[]>(client, domCandidatesExpression);
    const axCandidates = await this.readModeCandidatesFromAccessibility(client);
    return [...(Array.isArray(domCandidates) ? domCandidates : []), ...axCandidates];
  }

  private async detectCurrentModeFromAccessibility(client: ClientDomains): Promise<DetectedMode | null> {
    const tree = await client.Accessibility?.getFullAXTree?.();
    const nodes = tree?.nodes ?? [];
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return null;
    }

    const candidates = nodes
      .map((node) => this.parseAxModeCandidate(node))
      .filter((value): value is { mode: DetectedMode; selected: boolean; label: string } => value !== null);

    if (candidates.length === 0) {
      return null;
    }

    const selected = candidates.find((candidate) => candidate.selected);
    if (selected) {
      return selected.mode;
    }

    return null;
  }

  private async readModeCandidatesFromAccessibility(client: ClientDomains): Promise<string[]> {
    const tree = await client.Accessibility?.getFullAXTree?.();
    const nodes = tree?.nodes ?? [];
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return [];
    }

    const lines: string[] = [];
    for (const node of nodes) {
      const parsed = this.parseAxModeCandidate(node);
      if (!parsed) {
        continue;
      }
      lines.push(`${parsed.selected ? "[*]" : "[ ]"} [AX] ${parsed.label}`);
      if (lines.length >= 30) {
        break;
      }
    }
    return lines;
  }

  private parseAxModeCandidate(node: unknown): { mode: DetectedMode; selected: boolean; label: string } | null {
    if (!node || typeof node !== "object") {
      return null;
    }

    const maybe = node as {
      role?: { value?: string };
      name?: { value?: string };
      properties?: Array<{ name?: string; value?: { value?: unknown } }>;
    };
    const role = String(maybe.role?.value ?? "").toLowerCase();
    const label = String(maybe.name?.value ?? "").trim();
    if (!label || !/(^|\b)(agent|ask|debug|plan|code)(\b|$)/i.test(label)) {
      return null;
    }
    if (role && !/(button|menuitem|radio|tab|toggle)/i.test(role)) {
      return null;
    }

    const mode = this.modeFromText(label);
    if (!mode) {
      return null;
    }

    let selected = false;
    for (const property of maybe.properties ?? []) {
      const name = String(property.name ?? "").toLowerCase();
      const value = String(property.value?.value ?? "").toLowerCase();
      if ((name === "selected" || name === "checked" || name === "pressed") && value === "true") {
        selected = true;
      }
    }

    return { mode, selected, label };
  }

  private modeFromText(value: string): DetectedMode | null {
    const text = String(value || "").toLowerCase();
    if (/(^|\b)agent(\b|$)/.test(text)) return "Agent";
    if (/(^|\b)ask(\b|$)/.test(text)) return "Ask";
    if (/(^|\b)debug(\b|$)/.test(text)) return "Debug";
    if (/(^|\b)plan(\b|$)/.test(text)) return "Plan";
    if (/(^|\b)code(\b|$)/.test(text)) return "Code";
    return null;
  }

  private async detectCurrentModel(client: ClientDomains): Promise<string | null> {
    const modelSelectorLiteral = JSON.stringify(config.cursorModelSelector);
    const expression = `
      (() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
        };

        // 1. Try configured model selector
        const configured = ${modelSelectorLiteral};
        if (configured) {
          const matches = Array.from(document.querySelectorAll(configured)).filter(isVisible);
          for (const el of matches) {
            const text = normalize(el.textContent || '');
            if (text && text.length < 80) return text;
          }
        }

        // 2. Fallback: look for known Cursor model display classes
        const fallbackSelectors = [
          '[class*="model-name-display"]',
          '[class*="composer-unified-dropdown-model"]',
          '[class*="bc-instance-header-model"]'
        ];
        for (const sel of fallbackSelectors) {
          const matches = Array.from(document.querySelectorAll(sel)).filter(isVisible);
          for (const el of matches) {
            const text = normalize(el.textContent || '');
            if (text && text.length < 80) return text;
          }
        }

        return null;
      })();
    `;
    return await this.cdp.evaluateJson<string | null>(client, expression);
  }

  private async clickModelOption(
    client: ClientDomains,
    targetModel: string
  ): Promise<{ ok: boolean; selectedModel: string | null }> {
    const modelSelectorLiteral = JSON.stringify(config.cursorModelSelector);
    const targetModelLiteral = JSON.stringify(targetModel.toLowerCase());
    const expression = `
      (() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const lower = (value) => normalize(value).toLowerCase();
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const target = ${targetModelLiteral};

        // Find the model dropdown trigger
        const configured = ${modelSelectorLiteral};
        const dropdownSelectors = configured
          ? [configured, '[class*="model-name-display"]', '[class*="composer-unified-dropdown-model"]']
          : ['[class*="model-name-display"]', '[class*="composer-unified-dropdown-model"]'];

        let dropdownEl = null;
        for (const sel of dropdownSelectors) {
          const matches = Array.from(document.querySelectorAll(sel)).filter(isVisible);
          if (matches.length > 0) {
            dropdownEl = matches[0];
            break;
          }
        }
        if (!dropdownEl) return { ok: false, selectedModel: null };

        // Check if already on the target model
        const currentText = lower(dropdownEl.textContent || '');
        if (currentText.includes(target)) {
          return { ok: true, selectedModel: normalize(dropdownEl.textContent || '') };
        }

        // Click to open the dropdown
        const clickTarget = dropdownEl.closest('button,[role="button"]') || dropdownEl;
        clickTarget.click();

        // Search for matching option in the opened menu
        const dr = clickTarget.getBoundingClientRect();
        const optionNodes = Array.from(
          document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],div,span,a,li')
        ).filter(isVisible);

        const scored = optionNodes
          .map((el) => {
            const text = lower(el.textContent || '');
            if (text.length > 80 || text.length < 2) return null;
            const er = el.getBoundingClientRect();
            const near = Math.abs(er.left - dr.left) <= 500 && Math.abs(er.top - dr.top) <= 600;
            if (!near) return null;
            // Score: exact match > includes > partial
            let score = 0;
            if (text === target) score = 100;
            else if (text.includes(target)) score = 80;
            else if (target.split(/[\\s-]+/).every(part => text.includes(part))) score = 60;
            else return null;
            return { el, text, score };
          })
          .filter(Boolean)
          .sort((a, b) => b.score - a.score);

        if (scored.length > 0) {
          scored[0].el.click();
          return { ok: true, selectedModel: normalize(scored[0].el.textContent || '') };
        }

        // Close dropdown if nothing matched (click away or press Escape)
        document.body.click();
        return { ok: false, selectedModel: normalize(dropdownEl.textContent || '') };
      })();
    `;
    const result = await this.cdp.evaluateJson<{ ok: boolean; selectedModel: string | null }>(client, expression);
    return result ?? { ok: false, selectedModel: null };
  }

  private async injectPromptText(client: ClientDomains, prompt: string): Promise<boolean> {
    const escapedPrompt = JSON.stringify(prompt);
    const expression = `
      (() => {
        const el = document.activeElement;
        if (!el) return false;
        const text = ${escapedPrompt};

        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
          el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }

        if (el.getAttribute && el.getAttribute('contenteditable') === 'true') {
          el.textContent = text;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
          return true;
        }

        return false;
      })();
    `;
    const injected = await this.cdp.evaluateJson<boolean>(client, expression);
    return injected === true;
  }

  private async pollLatestAssistantSnippet(
    client: ClientDomains,
    timeoutMs: number,
    baselineSnippet: string | null
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    let lastValue: string | null = baselineSnippet;
    let changedAtMs: number | null = null;
    while (Date.now() < deadline) {
      const snippet = await this.readLatestAssistantSnippet(client);
      if (snippet && snippet !== baselineSnippet) {
        if (snippet !== lastValue) {
          changedAtMs = Date.now();
        }
        lastValue = snippet;
        // Return once response changed and appears stable briefly.
        if (changedAtMs !== null && Date.now() - changedAtMs >= 900) {
          return lastValue;
        }
      }
      await wait(300);
    }
    return lastValue && lastValue !== baselineSnippet ? lastValue : null;
  }

  private async readLatestAssistantSnippet(client: ClientDomains): Promise<string | null> {
    const selectorLiteral = JSON.stringify(config.cursorResponseSelector);
    const expression = `
      (() => {
        function getNodeText(node) {
          if (!node) return '';
          const inner = typeof node.innerText === 'string' ? node.innerText : '';
          const text = typeof node.textContent === 'string' ? node.textContent : '';
          return inner && inner.trim().length > 0 ? inner : text;
        }

        function sanitize(text) {
          const raw = String(text || '').replace(/\\r\\n/g, '\\n');
          const lines = raw.split('\\n').map((line) => line.replace(/\\s+$/g, ''));
          const kept = [];
          let blankRun = 0;
          for (const line of lines) {
            if (line.trim().length === 0) {
              blankRun += 1;
              if (blankRun > 2) continue;
              kept.push('');
              continue;
            }
            blankRun = 0;
            kept.push(line);
          }
          return kept.join('\\n').trim();
        }

        const configured = ${selectorLiteral};
        if (configured) {
          const nodes = Array.from(document.querySelectorAll(configured));
          if (nodes.length > 0) {
            const txt = sanitize(getNodeText(nodes[nodes.length - 1]));
            return txt ? txt.slice(0, 3200) : null;
          }
        }

        const selectors = [
          '[data-role*="assistant"]',
          '[class*="assistant"]',
          '[data-testid*="assistant"]',
          '[class*="composer-rendered-message"]',
          '.anysphere-markdown-container-root',
          'article',
          '[role="article"]',
          '.message'
        ];
        const candidates = Array.from(document.querySelectorAll(selectors.join(',')));
        for (let i = candidates.length - 1; i >= 0; i -= 1) {
          const node = candidates[i];
          const txt = sanitize(getNodeText(node));
          if (txt.length >= 8) {
            return txt.slice(0, 3200);
          }
        }
        return null;
      })();
    `;
    return await this.cdp.evaluateJson<string | null>(client, expression);
  }
}
