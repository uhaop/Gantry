import { BridgeMode, BridgeResponse } from "../types";
import { logger } from "../logger";
import { config } from "../config";
import { ClientDomains, CdpTargetSummary, wait } from "../cdp/BaseCdpClient";
import { VscodeCdpClient } from "./VscodeCdpClient";

// VS Code automation is best-effort on stock VS Code surfaces.
// Selector overrides remain available when UI layouts change.
export class VscodeAutomationClient {
  private readonly cdp = new VscodeCdpClient();

  async listChatTargets(): Promise<CdpTargetSummary[]> {
    try {
      return await this.cdp.listTargets();
    } catch (error) {
      logger.warn({ error }, "Failed to list VS Code targets through CDP");
      return [];
    }
  }

  async targetSelectionStatus(): Promise<{ mode: "auto" | "manual"; manualTargetId: string | null; manualTargetTitle: string | null }> {
    try {
      return await this.cdp.getSelectionState();
    } catch (error) {
      logger.warn({ error }, "Failed to read VS Code target selection state");
      return { mode: "auto", manualTargetId: null, manualTargetTitle: null };
    }
  }

  async selectTarget(selection: "auto" | number): Promise<BridgeResponse> {
    if (selection === "auto") {
      this.cdp.clearManualTarget();
      return { text: "Target selection set to auto.", metadata: { target_mode: "auto" } };
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
    if (mode === "debug") {
      return { text: "Debug mode is not available for VS Code. Available modes: ask|code|plan.", metadata: { status: "unsupported" } };
    }
    const target = this.mapBridgeModeToVscode(mode);
    if (!target) {
      return { text: `Mode mapping is unavailable for VS Code (${mode}).`, metadata: { status: "unsupported" } };
    }

    try {
      const changed = await this.cdp.withClient(async (client) => {
        // Keyboard-first strategy:
        // switch mode via shortcuts first, then verify from DOM.
        let changed = await this.changeModeByToggleShortcut(client, target);
        if (!changed && target === "code") {
          // Direct fallback for Agent mode selection.
          changed = await this.changeModeByOpenAgentShortcut(client);
        }
        if (!changed) {
          // Keyboard picker fallback: type mode and accept.
          changed = await this.changeModeByKeyboardPicker(client, target);
        }
        if (!changed) {
          // Last resort only: direct DOM click.
          changed = await this.changeModeBestEffort(client, target);
        }
        if (!changed) return false;
        return await this.waitForModeConfirmation(client, target, 2200);
      });
      if (changed) {
        return { text: `VS Code mode switched to ${mode}.`, metadata: { status: "switched", mode } };
      }
      return {
        text: `Mode action attempted for VS Code (${mode}), but confirmation failed. Keep chat visible and retry.`,
        metadata: { status: "unverified", mode }
      };
    } catch (error) {
      logger.warn({ error, mode }, "VS Code mode switch failed");
      return {
        text: `Mode switch failed through CDP for VS Code (${mode}). Keep chat visible and retry.`,
        metadata: { status: "failed", mode }
      };
    }
  }

  async getModel(): Promise<BridgeResponse> {
    try {
      const model = await this.cdp.withClient(async (client) => this.readCurrentModelLabel(client));
      if (model) {
        return { text: `Current VS Code model: ${model}`, metadata: { status: "detected", model } };
      }
      return {
        text: "Model detection is currently unverified for VS Code. Keep chat/model toolbar visible and retry.",
        metadata: { status: "unverified" }
      };
    } catch (error) {
      logger.warn({ error }, "VS Code model detection failed");
      return { text: "Model detection failed through CDP for VS Code.", metadata: { status: "failed" } };
    }
  }

  async setModel(modelName: string): Promise<BridgeResponse> {
    const desired = String(modelName || "").trim();
    if (!desired) {
      return { text: "Model name is required. Use /model <name>.", metadata: { status: "invalid-args" } };
    }

    try {
      return await this.cdp.withClient(async (client) => {
        const before = await this.readCurrentModelLabel(client);
        const opened = await this.openModelPicker(client);
        if (!opened) {
          return {
            text: "Could not open VS Code model picker. Keep chat panel visible and retry.",
            metadata: { status: "failed-open-picker" }
          };
        }

        let options = await this.readVisibleModelOptions(client);
        const target = this.pickBestModelOption(options, desired);
        if (!target) {
          await this.safeClosePicker(client);
          const current = before ?? "unknown";
          return {
            text: `Could not switch model to "${desired}" in VS Code. Current model: ${current}.`,
            metadata: {
              status: "model-not-found",
              current,
              requested: desired,
              candidates: options.slice(0, 12).join(" | ")
            }
          };
        }

        const clicked = await this.selectModelOption(client, target);
        if (!clicked) {
          await this.safeClosePicker(client);
          return {
            text: `Model picker opened, but selection click failed for "${target}" (VS Code).`,
            metadata: { status: "failed-select", requested: desired, target }
          };
        }

        const after = await this.waitForModelConfirmation(client, target, 2600);
        await this.safeClosePicker(client);
        if (after && this.modelNameMatches(after, target)) {
          return {
            text: `VS Code model switched to ${after}.`,
            metadata: { status: "switched", requested: desired, model: after }
          };
        }

        const current = (await this.readCurrentModelLabel(client)) ?? "unknown";
        return {
          text: `Model action attempted for VS Code (${desired}), but confirmation is unverified. Current label: ${current}.`,
          metadata: { status: "unverified", requested: desired, target, model: current }
        };
      });
    } catch (error) {
      logger.warn({ error, modelName: desired }, "VS Code model switch failed");
      return {
        text: `Model switch failed through CDP for VS Code (${desired}).`,
        metadata: { status: "failed", requested: desired }
      };
    }
  }

  async listModels(): Promise<BridgeResponse> {
    try {
      return await this.cdp.withClient(async (client) => {
        const before = await this.readCurrentModelLabel(client);
        const opened = await this.openModelPicker(client);
        if (!opened) {
          return {
            text: "Could not open VS Code model picker to list models.",
            metadata: { status: "failed-open-picker" }
          };
        }
        let options = await this.readVisibleModelOptions(client);
        await this.safeClosePicker(client);
        if (options.length === 0) {
          return {
            text: "Model picker opened, but no visible model options were detected (VS Code).",
            metadata: { status: "unverified" }
          };
        }
        if (options.length <= 1) {
          const cycled = await this.collectModelsByCycling(client, before ?? options[0] ?? null, 18);
          if (cycled.length > options.length) {
            options = cycled;
          }
        }
        const lines = ["VS Code models (best-effort):", ...options.slice(0, 20).map((opt, i) => `${i + 1}. ${opt}`)];
        return { text: lines.join("\n"), metadata: { status: "listed", count: options.length } };
      });
    } catch (error) {
      logger.warn({ error }, "VS Code model list failed");
      return { text: "Model listing failed through CDP for VS Code.", metadata: { status: "failed" } };
    }
  }

  async newChat(): Promise<BridgeResponse> {
    try {
      const dispatched = await this.cdp.withClient(async (client) => {
        const focused = await this.focusChatInput(client);
        const clicked = await this.clickNewChatBestEffort(client);
        if (clicked) return true;
        // User-confirmed fallback: custom keybind mapped to chat.newChat.
        await this.cdp.sendShortcut(client, "n", "KeyN", 78, 10);
        await wait(260);
        const afterCustomShortcut = await this.clickNewChatBestEffort(client);
        if (afterCustomShortcut) return true;
        if (!focused) return false;
        await this.cdp.sendShortcut(client, "l", "KeyL", 76, 2);
        await wait(260);
        return await this.clickNewChatBestEffort(client);
      });
      if (dispatched) {
        return {
          text: "New chat action attempted in VS Code, but completion is unverified. Confirm visually in chat panel.",
          metadata: { status: "unverified" }
        };
      }
      return {
        text: "Could not trigger new chat in VS Code. Keep chat panel open and retry.",
        metadata: { status: "failed" }
      };
    } catch (error) {
      logger.warn({ error }, "VS Code new chat dispatch failed");
      return {
        text: "New chat dispatch failed through CDP for VS Code.",
        metadata: { status: "failed" }
      };
    }
  }

  async sendPrompt(prompt: string): Promise<BridgeResponse> {
    logger.info({ length: prompt.length }, "VS Code prompt relay requested");

    try {
      const relayResult = await this.cdp.withClient(async (client) => {
        const focused = await this.focusChatInput(client);
        if (!focused) {
          return { status: "failed-focus-or-injection" as const, responseSnippet: null as string | null };
        }

        const baselineSnippet = await this.readLatestAssistantSnippet(client);
        let injected = await this.injectPromptByKeyboard(client, prompt);
        if (!injected) {
          injected = await this.injectPromptText(client, prompt);
        }
        if (!injected) {
          return { status: "failed-focus-or-injection" as const, responseSnippet: null as string | null };
        }

        const dispatched = await this.dispatchPrompt(client, prompt);
        if (!dispatched) {
          return { status: "unverified-submit" as const, responseSnippet: null as string | null };
        }
        const responseSnippet = await this.pollLatestAssistantSnippet(client, config.vscodeActionTimeoutMs, baselineSnippet);
        return { status: "submitted" as const, responseSnippet };
      });

      if (relayResult.status === "failed-focus-or-injection") {
        return {
          text: "Prompt relay failed: chat input could not be focused or text injection failed (VS Code).",
          metadata: { status: "failed" }
        };
      }

      if (relayResult.status === "unverified-submit") {
        return {
          text: "Prompt text was injected, but submit could not be verified (VS Code). Keep chat input focused and press Enter once, then run /last.",
          metadata: { status: "unverified" }
        };
      }

      if (relayResult.responseSnippet) {
        return { text: relayResult.responseSnippet, metadata: { status: "delivered" } };
      }

      return {
        text: "Prompt delivered, but response capture is pending (VS Code). Try /diag and resend if no reply appears shortly.",
        metadata: { status: "delivered-no-snippet" }
      };
    } catch (error) {
      logger.warn({ error }, "CDP prompt relay failed for VS Code");
      return {
        text: "Prompt relay failed through CDP. Check VS Code remote debugging endpoint and target selection.",
        metadata: { status: "failed" }
      };
    }
  }

  async latestAssistantSnippet(): Promise<string | null> {
    try {
      return await this.cdp.withClient(async (client) => this.readLatestAssistantSnippet(client));
    } catch (error) {
      logger.warn({ error }, "Failed reading latest VS Code assistant snippet");
      return null;
    }
  }

  async diagnostics(): Promise<{
    cdpReachable: boolean;
    versionEndpointReachable: boolean;
    targetCount: number;
    pageTargetCount: number;
    selectedTargetTitle: string | null;
    chatInputFocusable: boolean | null;
    detectedMode: string | null;
    configuredSelectors: { chatInput: string; response: string };
    targetSelection: { mode: "auto" | "manual"; manualTargetId: string | null; manualTargetTitle: string | null };
    notes: string[];
    selectorHealth: {
      configuredChatInputMatches: number;
      configuredResponseMatches: number;
      fallbackTextboxCandidates: number;
      fallbackResponseCandidates: number;
    };
  }> {
    const notes: string[] = [];
    const configuredSelectors = {
      chatInput: config.vscodeChatInputSelector,
      response: config.vscodeResponseSelector
    };

    let versionEndpointReachable = false;
    try {
      const version = await this.cdp.readVersionInfo();
      versionEndpointReachable = Boolean(version?.webSocketDebuggerUrl);
      if (!versionEndpointReachable) {
        notes.push("Version endpoint reachable but webSocketDebuggerUrl missing.");
      }
    } catch (error) {
      logger.warn({ error }, "CDP version endpoint check failed (VS Code)");
      notes.push("Version endpoint check failed.");
    }

    try {
      const targetSelection = await this.cdp.getSelectionState();
      const targets = await this.listChatTargets();
      const pageTargets = targets.filter((t) => t.type === "page");
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
            fallbackTextboxCandidates: 0,
            fallbackResponseCandidates: 0
          }
        };
      }

      const runtimeCheck = await this.cdp.withClient(async (client, target) => {
        const focusable = await this.focusChatInput(client);
        const selectorHealth = await this.readSelectorHealth(client);
        const detectedMode = await this.detectMode(client);
        const snippet = await this.readLatestAssistantSnippet(client);
        if (snippet) {
          notes.push(`Snippet sample: ${snippet.slice(0, 160)}`);
        }
        return {
          selectedTargetTitle: target.title,
          chatInputFocusable: focusable,
          detectedMode,
          selectorHealth
        };
      });

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
      logger.warn({ error }, "CDP runtime diagnostics failed (VS Code)");
      return {
        cdpReachable: false,
        versionEndpointReachable,
        targetCount: 0,
        pageTargetCount: 0,
        selectedTargetTitle: null,
        chatInputFocusable: null,
        detectedMode: null,
        configuredSelectors,
        targetSelection: { mode: "auto", manualTargetId: null, manualTargetTitle: null },
        notes: [...notes, "Runtime diagnostics failed."],
        selectorHealth: {
          configuredChatInputMatches: 0,
          configuredResponseMatches: 0,
          fallbackTextboxCandidates: 0,
          fallbackResponseCandidates: 0
        }
      };
    }
  }

  // --- Helpers ---

  private async focusChatInput(client: ClientDomains): Promise<boolean> {
    const selector = config.vscodeChatInputSelector;
    const expression = `(() => {
      const configuredSelector = ${JSON.stringify(selector)};
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const asArray = (nodes) => Array.from(nodes || []);
      const score = (el, viaConfigured) => {
        const text = String(
          (el.getAttribute?.('aria-label') || '') + ' ' +
          (el.getAttribute?.('placeholder') || '') + ' ' +
          (el.className || '')
        ).toLowerCase();
        const rect = el.getBoundingClientRect();
        let value = 0;
        if (viaConfigured) value += 120;
        if (text.includes('chat')) value += 40;
        if (text.includes('copilot')) value += 40;
        if (text.includes('interactive')) value += 25;
        if (text.includes('input')) value += 18;
        if (text.includes('prompt')) value += 18;
        if (text.includes('xterm') || text.includes('terminal') || text.includes('monaco')) value -= 220;
        if (rect.top > window.innerHeight * 0.45) value += 8;
        if (rect.height >= 18) value += 5;
        return value;
      };

      const ranked = [];
      if (configuredSelector) {
        for (const el of asArray(document.querySelectorAll(configuredSelector))) {
          if (!isVisible(el)) continue;
          ranked.push({ el, score: score(el, true) });
        }
      }

      const fallback = asArray(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]'));
      for (const el of fallback) {
        if (!isVisible(el)) continue;
        ranked.push({ el, score: score(el, false) });
      }

      ranked.sort((a, b) => b.score - a.score);
      const best = ranked[0]?.el || null;
      if (!best || typeof best.focus !== 'function') return false;
      best.focus();
      return document.activeElement === best || isVisible(best);
    })();`;
    const focused = await this.cdp.evaluateJson<boolean>(client, expression);
    return Boolean(focused);
  }

  private async injectPromptText(client: ClientDomains, prompt: string): Promise<boolean> {
    const selector = config.vscodeChatInputSelector;
    const escaped = JSON.stringify(prompt);
    const expression = `(() => {
      const configuredSelector = ${JSON.stringify(selector)};
      const isVisible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const isEditable = (node) => {
        if (!node) return false;
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return true;
        if (node.isContentEditable) return true;
        return String(node.getAttribute?.('contenteditable') || '').toLowerCase() === 'true';
      };
      const score = (node, viaConfigured) => {
        const text = String(
          (node.getAttribute?.('aria-label') || '') + ' ' +
          (node.getAttribute?.('placeholder') || '') + ' ' +
          (node.className || '')
        ).toLowerCase();
        let value = viaConfigured ? 120 : 0;
        if (text.includes('chat')) value += 40;
        if (text.includes('copilot')) value += 40;
        if (text.includes('interactive')) value += 25;
        if (text.includes('input')) value += 18;
        if (!isEditable(node)) value -= 180;
        if (text.includes('xterm') || text.includes('terminal') || text.includes('monaco')) value -= 220;
        return value;
      };
      const candidates = [];
      if (configuredSelector) {
        for (const node of Array.from(document.querySelectorAll(configuredSelector))) {
          if (!isVisible(node)) continue;
          candidates.push({ node, score: score(node, true) });
        }
      }
      for (const node of Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]'))) {
        if (!isVisible(node)) continue;
        candidates.push({ node, score: score(node, false) });
      }
      candidates.sort((a, b) => b.score - a.score);
      const el = candidates[0]?.node || null;
      if (!el || !isEditable(el)) return false;
      if (typeof el.focus === 'function') el.focus();
      if ('value' in el) {
        el.value = ${escaped};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = ${escaped};
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${escaped}, inputType: 'insertText' }));
      } else {
        return false;
      }
      return true;
    })();`;
    const ok = await this.cdp.evaluateJson<boolean>(client, expression);
    return Boolean(ok);
  }

  private async injectPromptByKeyboard(client: ClientDomains, prompt: string): Promise<boolean> {
    try {
      await this.cdp.sendText(client, prompt);
      return true;
    } catch (error) {
      logger.warn({ error }, "VS Code keyboard text injection fallback failed");
      return false;
    }
  }

  private mapBridgeModeToVscode(mode: Exclude<BridgeMode, "debug">): "ask" | "code" | "plan" | null {
    if (mode === "ask") return "ask";
    if (mode === "code") return "code";
    if (mode === "plan") return "plan";
    return null;
  }

  private async detectMode(client: ClientDomains): Promise<string | null> {
    const expression = `(() => {
      const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
      const lower = (v) => normalize(v).toLowerCase();
      const mapLabelToBridge = (label) => {
        const l = lower(label);
        if (l === 'ask') return 'ask';
        if (l === 'agent') return 'code';
        if (l === 'plan') return 'plan';
        return null;
      };
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
      };

      // Primary signal: currently selected chat mode pill label in input toolbar.
      const primaryLabel = document.querySelector(
        'li.chat-mode-picker-item span.chat-input-picker-label'
      );
      if (primaryLabel && isVisible(primaryLabel)) {
        const mapped = mapLabelToBridge(primaryLabel.textContent || '');
        if (mapped) return mapped;
      }

      // Primary signal: mode button aria format "Set Agent (Ctrl+.) - Ask|Agent|Plan"
      const controls = Array.from(document.querySelectorAll('button,[role=\"button\"],a,[aria-label],[title]')).filter(isVisible);
      const scored = [];
      for (const el of controls) {
        const aria = normalize(el.getAttribute('aria-label'));
        const text = normalize(el.textContent);
        const raw = aria + ' ' + text;
        const match = raw.match(/set\\s+agent[^-]*-\\s*(ask|agent|plan)\\b/i);
        if (!match) continue;
        const token = lower(match[1]);
        const role = lower(el.getAttribute('role') || '');
        const selected =
          lower(el.getAttribute('aria-selected') || '') === 'true' ||
          lower(el.getAttribute('aria-pressed') || '') === 'true' ||
          lower(el.getAttribute('aria-current') || '') === 'true' ||
          lower(el.getAttribute('data-state') || '') === 'selected' ||
          lower(el.getAttribute('data-state') || '') === 'active';
        let score = 0;
        if (selected) score += 120;
        if (role === 'button' || (el.tagName || '').toLowerCase() === 'button') score += 25;
        if (role === 'option' || role === 'menuitem') score -= 40;
        const textOnly = lower(text);
        if (textOnly === token) score += 20;
        scored.push({ token, score });
      }
      if (scored.length > 0) {
        scored.sort((a, b) => b.score - a.score);
        const top = scored[0]?.token;
        if (top === 'ask') return 'ask';
        if (top === 'agent') return 'code';
        if (top === 'plan') return 'plan';
      }

      // Secondary signal: descriptive tooltip/help text for mode options.
      // Useful when exact "Set Agent - <mode>" label is hidden by layout changes.
      for (const el of controls) {
        const text = lower(
          (el.textContent || '') + ' ' +
          (el.getAttribute('aria-label') || '') + ' ' +
          (el.getAttribute('title') || '')
        );
        if (!text) continue;
        if (text.includes('edits files in your workspace') || text.includes('agent mode')) return 'code';
        if (text.includes('answer questions without making changes')) return 'ask';
        if (text.includes('researches and outlines multi-step plans')) return 'plan';
      }

      // Deliberately avoid broad "any Ask/Agent/Plan word on screen" fallback.
      // It causes false positives when command palette or docs text is visible.
      return null;
    })();`;
    const mode = await this.cdp.evaluateJson<string | null>(client, expression);
    return mode ? String(mode) : null;
  }

  private async clickNewChatBestEffort(client: ClientDomains): Promise<boolean> {
    const expression = `(() => {
      const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const buttons = Array.from(document.querySelectorAll('button,[role=\"button\"],a,[title],[aria-label]')).filter(isVisible);
      const ranked = buttons
        .map((el) => {
          const text = normalize(
            (el.textContent || '') + ' ' +
            (el.getAttribute('aria-label') || '') + ' ' +
            (el.getAttribute('title') || '') + ' ' +
            (el.getAttribute('data-testid') || '') + ' ' +
            (el.className || '')
          );
          let score = 0;
          if (text.includes('new chat')) score += 120;
          if (text.includes('start new chat')) score += 120;
          if (text.includes('new session')) score += 110;
          if (text.includes('chat') && text.includes('new')) score += 80;
          if (text.includes('plus')) score += 20;
          if (text.includes('close') || text.includes('hide') || text.includes('dismiss')) score -= 200;
          return { el, score };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);
      const top = ranked[0];
      if (!top) return false;
      top.el.click();
      return true;
    })();`;
    return Boolean(await this.cdp.evaluateJson<boolean>(client, expression));
  }

  private async changeModeBestEffort(client: ClientDomains, mode: "ask" | "code" | "plan"): Promise<boolean> {
    const expression = `((async () => {
      const target = ${JSON.stringify(mode)};
      const targetLabel = target === 'code' ? 'agent' : target;
      const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
      const lower = (v) => normalize(v).toLowerCase();
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const clickElement = (el) => {
        if (!el || typeof el.click !== 'function') return false;
        el.click();
        return true;
      };
      const directMap = (label) => {
        const l = lower(label);
        if (l === 'ask') return 'ask';
        if (l === 'agent') return 'code';
        if (l === 'plan') return 'plan';
        return null;
      };

      const pickerItem = document.querySelector('li.chat-mode-picker-item');
      const pickerLabel = pickerItem?.querySelector('span.chat-input-picker-label');
      if (pickerLabel && isVisible(pickerLabel)) {
        const current = directMap(pickerLabel.textContent || '');
        if (current === target) return true;
      }

      const pickerTrigger =
        pickerItem?.querySelector('a,button,[role=\"button\"]') ||
        Array.from(document.querySelectorAll('a,button,[role=\"button\"]'))
          .filter(isVisible)
          .find((el) => lower((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).includes('set agent'));
      if (!pickerTrigger) return false;

      if (!clickElement(pickerTrigger)) return false;
      await sleep(220);

      // Try selecting a visible option with exact Ask/Agent/Plan label.
      const optionLabels = Array.from(document.querySelectorAll('span.chat-input-picker-label,[role=\"option\"], [role=\"menuitem\"], button, a, li'))
        .filter(isVisible)
        .map((el) => {
          const text = lower(el.textContent || el.getAttribute?.('aria-label') || '');
          if (!text) return null;
          const exact = text === targetLabel;
          if (!exact) return null;
          const role = lower(el.getAttribute?.('role') || '');
          let score = 0;
          if (role === 'option' || role === 'menuitem') score += 30;
          if ((el.className || '').toString().toLowerCase().includes('chat-input-picker-label')) score += 20;
          const clickable = el.closest?.('a,button,[role=\"option\"],[role=\"menuitem\"],[role=\"button\"],li,div') || el;
          return { clickable, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
      const hit = optionLabels[0];
      if (!hit) {
        return false;
      }
      if (!clickElement(hit.clickable)) return false;
      await sleep(220);

      // Confirm via mode pill label to avoid stale detection.
      const afterLabel = document.querySelector('li.chat-mode-picker-item span.chat-input-picker-label');
      if (!afterLabel || !isVisible(afterLabel)) return false;
      return directMap(afterLabel.textContent || '') === target;
    })());`;
    return Boolean(await this.cdp.evaluateJson<boolean>(client, expression));
  }

  private async changeModeByKeyboardPicker(client: ClientDomains, mode: "ask" | "code" | "plan"): Promise<boolean> {
    const targetLabel = mode === "code" ? "agent" : mode;
    try {
      let pickerOpen = await this.isQuickPickVisible(client);
      if (!pickerOpen) {
        // "Set Agent (Ctrl+.)" may be unbound on some user setups.
        await this.cdp.sendShortcut(client, ".", "Period", 190, 2);
        await wait(200);
        pickerOpen = await this.isQuickPickVisible(client);
      }
      if (!pickerOpen) {
        // Fallback: open picker by clicking the mode pill in chat toolbar.
        pickerOpen = await this.openModePickerByDom(client);
      }
      if (!pickerOpen) return false;

      // Reset any stale quick-pick query before typing target mode.
      await this.cdp.sendShortcut(client, "a", "KeyA", 65, 2);
      await wait(60);
      await this.cdp.sendShortcut(client, "Backspace", "Backspace", 8, 0);
      await wait(60);
      await this.cdp.sendText(client, targetLabel);
      await wait(160);
      await this.cdp.sendShortcut(client, "Enter", "Enter", 13, 0);
      await wait(280);

      let detected = await this.detectMode(client);
      if (detected === mode) return true;

      // Some quick-pick states require one extra accept.
      if (await this.isQuickPickVisible(client)) {
        await this.cdp.sendShortcut(client, "Enter", "Enter", 13, 0);
        await wait(260);
        detected = await this.detectMode(client);
      }
      return detected === mode;
    } catch (error) {
      logger.warn({ error, mode }, "VS Code keyboard picker mode fallback failed");
      return false;
    }
  }

  private async openModePickerByDom(client: ClientDomains): Promise<boolean> {
    const expression = `(() => {
      const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const pickerItem = document.querySelector('li.chat-mode-picker-item');
      const trigger =
        pickerItem?.querySelector('a,button,[role="button"]') ||
        Array.from(document.querySelectorAll('a,button,[role="button"]'))
          .filter(isVisible)
          .find((el) => normalize((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).includes('set agent'));
      if (!trigger || typeof trigger.click !== 'function') return false;
      trigger.click();
      return true;
    })();`;
    const opened = await this.cdp.evaluateJson<boolean>(client, expression);
    if (!opened) return false;
    await wait(200);
    return await this.isQuickPickVisible(client);
  }

  private async waitForModeConfirmation(
    client: ClientDomains,
    mode: "ask" | "code" | "plan",
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const detected = await this.detectMode(client);
      if (detected === mode) return true;
      await wait(140);
    }
    return false;
  }

  private async changeModeByToggleShortcut(client: ClientDomains, mode: "ask" | "code" | "plan"): Promise<boolean> {
    try {
      const asMode = (value: string | null): "ask" | "code" | "plan" | null =>
        value === "ask" || value === "code" || value === "plan" ? value : null;

      let current = asMode(await this.detectMode(client));
      if (current === mode) return true;

      // If current mode cannot be read, do not rotate blindly.
      if (!current) {
        return false;
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (current === mode) return true;
        const currentMode: "ask" | "plan" | "code" = current;
        const nextExpectedMode: "ask" | "plan" | "code" =
          currentMode === "ask" ? "plan" : currentMode === "plan" ? "code" : "ask";
        // User-confirmed keybind: workbench.action.chat.toggleAgentMode -> Ctrl+Alt+G
        await this.cdp.sendShortcut(client, "g", "KeyG", 71, 3);
        await wait(240);
        const after = asMode(await this.detectMode(client));
        if (!after) return false;
        if (after !== nextExpectedMode && after !== mode) {
          // Unexpected transition; stop to avoid full-cycle glitches.
          return false;
        }
        current = after;
      }
      return current === mode;
    } catch (error) {
      logger.warn({ error, mode }, "VS Code toggle shortcut mode fallback failed");
      return false;
    }
  }

  private async changeModeByOpenAgentShortcut(client: ClientDomains): Promise<boolean> {
    try {
      // VS Code default: workbench.action.chat.openagent -> Ctrl+Shift+I
      await this.cdp.sendShortcut(client, "i", "KeyI", 73, 10);
      await wait(260);
      return (await this.detectMode(client)) === "code";
    } catch (error) {
      logger.warn({ error }, "VS Code open-agent shortcut mode fallback failed");
      return false;
    }
  }

  private async isQuickPickVisible(client: ClientDomains): Promise<boolean> {
    const expression = `(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const nodes = Array.from(document.querySelectorAll(
        '.quick-input-widget,[class*="quick-input"],[role="dialog"],[role="listbox"]'
      ));
      return nodes.some((el) => isVisible(el));
    })();`;
    return Boolean(await this.cdp.evaluateJson<boolean>(client, expression));
  }

  private async dispatchPrompt(client: ClientDomains, prompt: string): Promise<boolean> {
    const attemptSubmit = async (withCtrl: boolean): Promise<boolean> => {
      await this.cdp.sendShortcut(client, "Enter", "Enter", 13, withCtrl ? 2 : 0);
      await wait(260);
      const stillPresent = await this.isPromptStillPresent(client, prompt);
      return !stillPresent;
    };

    // Keep submission conservative for VS Code:
    // keyboard-only attempts avoid risky click heuristics.
    if (await attemptSubmit(false)) return true;
    if (await attemptSubmit(true)) return true;
    return false;
  }

  private async isPromptStillPresent(client: ClientDomains, prompt: string): Promise<boolean> {
    const expression = `(() => {
      const norm = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
      const target = norm(${JSON.stringify(prompt)});
      if (!target) return false;
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const nodes = Array.from(document.querySelectorAll('textarea,[contenteditable=\"true\"],[role=\"textbox\"]')).filter(isVisible);
      return nodes.some((el) => {
        const text = 'value' in el ? String(el.value || '') : String(el.textContent || '');
        return norm(text).includes(target);
      });
    })();`;
    return Boolean(await this.cdp.evaluateJson<boolean>(client, expression));
  }

  private async readLatestAssistantSnippet(client: ClientDomains): Promise<string | null> {
    const selector = config.vscodeResponseSelector;
    const expression = `(() => {
      const configuredSelector = ${JSON.stringify(selector)};
      const selectors = [
        configuredSelector,
        '[class*="chat-response"]',
        '[class*="chat-message"] [class*="markdown"]',
        '[class*="interactive-response"] [class*="markdown"]',
        '[class*="markdown-body"]',
        '[role="article"]',
        'article'
      ].filter(Boolean);
      const seen = new Set();
      const nodes = [];
      for (const sel of selectors) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          if (seen.has(el)) continue;
          seen.add(el);
          nodes.push(el);
        }
      }
      const visible = nodes.filter((el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 3 && r.height > 3 && s.visibility !== 'hidden' && s.display !== 'none';
      });
      for (let i = visible.length - 1; i >= 0; i -= 1) {
        const text = visible[i]?.innerText || visible[i]?.textContent || '';
        const trimmed = String(text || '').trim();
        if (trimmed.length > 0) return trimmed;
      }
      return null;
    })();`;
    const text = await this.cdp.evaluateJson<string | null>(client, expression);
    if (!text) return null;
    return String(text).trim() || null;
  }

  private async pollLatestAssistantSnippet(
    client: ClientDomains,
    timeoutMs: number,
    baseline: string | null
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await this.readLatestAssistantSnippet(client);
      if (current && current !== baseline) {
        return current;
      }
      await wait(240);
    }
    return null;
  }

  private async readSelectorHealth(client: ClientDomains): Promise<{
    configuredChatInputMatches: number;
    configuredResponseMatches: number;
    fallbackTextboxCandidates: number;
    fallbackResponseCandidates: number;
  }> {
    const expression = `(() => {
      const countVisible = (selector) => {
        if (!selector) return 0;
        const nodes = Array.from(document.querySelectorAll(selector));
        return nodes.filter((el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 3 && r.height > 3 && s.visibility !== 'hidden' && s.display !== 'none';
        }).length;
      };
      return {
        configuredChatInputMatches: countVisible(${JSON.stringify(config.vscodeChatInputSelector)}),
        configuredResponseMatches: countVisible(${JSON.stringify(config.vscodeResponseSelector)}),
        fallbackTextboxCandidates: countVisible('textarea,[contenteditable="true"],[role="textbox"]'),
        fallbackResponseCandidates: countVisible('[class*="chat-response"],[class*="chat-message"] [class*="markdown"],[class*="interactive-response"] [class*="markdown"],[class*="markdown-body"],[role="article"],article')
      };
    })();`;
    const result = await this.cdp.evaluateJson<{
      configuredChatInputMatches: number;
      configuredResponseMatches: number;
      fallbackTextboxCandidates: number;
      fallbackResponseCandidates: number;
    }>(client, expression);
    if (!result) {
      return {
        configuredChatInputMatches: 0,
        configuredResponseMatches: 0,
        fallbackTextboxCandidates: 0,
        fallbackResponseCandidates: 0
      };
    }
    return result;
  }

  private async readCurrentModelLabel(client: ClientDomains): Promise<string | null> {
    const expression = `(() => {
      const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
      const lower = (v) => normalize(v).toLowerCase();
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const isModeLabel = (v) => ['ask', 'agent', 'plan'].includes(lower(v));
      const configuredSelector = ${JSON.stringify(config.vscodeModelSelector || "")};
      const candidates = [];

      const addCandidate = (el, viaConfigured) => {
        if (!el || !isVisible(el)) return;
        const text = normalize(el.textContent || '');
        if (!text) return;
        const clickable = el.closest('a,button,[role="button"],[role="menuitem"],li,div');
        const meta = lower(
          (clickable?.getAttribute?.('aria-label') || '') + ' ' +
          (clickable?.getAttribute?.('title') || '') + ' ' +
          (clickable?.className || '')
        );
        const li = el.closest('li');
        const liIndex = li && li.parentElement ? (Array.from(li.parentElement.children).indexOf(li) + 1) : 0;
        let score = 0;
        if (viaConfigured) score += 350;
        if (isModeLabel(text)) score -= 350;
        if (meta.includes('set agent')) score -= 260;
        if (meta.includes('model')) score += 140;
        if (liIndex === 3) score += 85;
        if (/(auto|claude|sonnet|haiku|opus|gpt|o1|o3|o4|gemini|llama|mistral|deepseek)/i.test(text)) score += 120;
        candidates.push({ text, score });
      };

      if (configuredSelector) {
        try {
          for (const el of Array.from(document.querySelectorAll(configuredSelector))) addCandidate(el, true);
        } catch {
          // best-effort selector only
        }
      }

      const fallbackSelectors = [
        'div.chat-input-toolbars span.chat-input-picker-label',
        'li:nth-child(3) span.chat-input-picker-label',
        'span.chat-input-picker-label'
      ];
      for (const sel of fallbackSelectors) {
        for (const el of Array.from(document.querySelectorAll(sel))) addCandidate(el, false);
      }

      if (!candidates.length) return null;
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0]?.text || null;
    })();`;
    const model = await this.cdp.evaluateJson<string | null>(client, expression);
    const trimmed = String(model || "").trim();
    return trimmed || null;
  }

  private async openModelPicker(client: ClientDomains): Promise<boolean> {
    const expression = `(() => {
      const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const configuredSelector = ${JSON.stringify(config.vscodeModelSelector || "")};
      const allClickables = Array.from(document.querySelectorAll('a,button,[role="button"],[role="menuitem"]')).filter(isVisible);
      const ranked = [];

      if (configuredSelector) {
        try {
          for (const el of Array.from(document.querySelectorAll(configuredSelector))) {
            if (!isVisible(el)) continue;
            const clickable = el.closest('a,button,[role="button"],[role="menuitem"]') || el;
            ranked.push({ el: clickable, score: 500 });
          }
        } catch {
          // invalid configured selector; continue best-effort
        }
      }

      for (const el of allClickables) {
        const text = normalize(
          (el.textContent || '') + ' ' +
          (el.getAttribute('aria-label') || '') + ' ' +
          (el.getAttribute('title') || '') + ' ' +
          (el.className || '')
        );
        let score = 0;
        if (text.includes('model')) score += 260;
        if (text.includes('set agent')) score -= 220;
        if (text.includes('new chat')) score -= 120;
        if (text.includes('auto') || text.includes('claude') || text.includes('gpt') || text.includes('sonnet')) score += 160;
        if (text.includes('chat-input-toolbar') || text.includes('chat-input-picker-label')) score += 90;
        const li = el.closest('li');
        const liIndex = li && li.parentElement ? (Array.from(li.parentElement.children).indexOf(li) + 1) : 0;
        if (liIndex === 3) score += 75;
        if (score > 0) ranked.push({ el, score });
      }

      ranked.sort((a, b) => b.score - a.score);
      const best = ranked[0]?.el || null;
      if (!best || typeof best.click !== 'function') return false;
      best.click();
      return true;
    })();`;
    const clicked = await this.cdp.evaluateJson<boolean>(client, expression);
    if (!clicked) return false;
    await wait(220);
    const quickPickVisible = await this.isQuickPickVisible(client);
    if (quickPickVisible) return true;
    const options = await this.readVisibleModelOptions(client);
    return options.length > 0;
  }

  private async readVisibleModelOptions(client: ClientDomains): Promise<string[]> {
    const expression = `(() => {
      const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
      const lower = (v) => normalize(v).toLowerCase();
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const out = [];
      const seen = new Set();
      const add = (v) => {
        const text = normalize(v);
        if (!text) return;
        const key = lower(text);
        if (seen.has(key)) return;
        seen.add(key);
        out.push(text);
      };

      const quick = document.querySelector('.quick-input-widget');
      const quickVisible = quick && isVisible(quick);
      if (quickVisible) {
        const rows = Array.from(quick.querySelectorAll('.monaco-list-row,[role="option"],[role="menuitem"],.quick-input-list-entry,.monaco-highlighted-label'));
        for (const row of rows) {
          if (!isVisible(row)) continue;
          const txt = normalize(row.textContent || '');
          if (!txt) continue;
          if (txt.length > 90) continue;
          if (lower(txt).includes('similar commands')) continue;
          if (lower(txt).includes('other commands')) continue;
          add(txt);
        }
      }

      if (!out.length) {
        const fallbackNodes = Array.from(document.querySelectorAll('[role="option"],[role="menuitem"],li,button,a,span'));
        for (const el of fallbackNodes) {
          if (!isVisible(el)) continue;
          const txt = normalize(el.textContent || '');
          if (!txt || txt.length > 80) continue;
          const token = lower(txt);
          if (!/(auto|claude|sonnet|haiku|opus|gpt|o1|o3|o4|gemini|llama|mistral|deepseek)/i.test(txt)) continue;
          if (token === 'ask' || token === 'agent' || token === 'plan') continue;
          add(txt);
        }
      }
      return out.slice(0, 40);
    })();`;
    const options = await this.cdp.evaluateJson<string[]>(client, expression);
    return Array.isArray(options) ? options.map((v) => String(v).trim()).filter(Boolean) : [];
  }

  private pickBestModelOption(options: string[], requested: string): string | null {
    if (options.length === 0) return null;
    const normalize = (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim();
    const req = normalize(requested);
    const reqWords = req.split(" ").filter(Boolean);
    let best: { value: string; score: number } | null = null;
    for (const option of options) {
      const value = String(option || "").trim();
      if (!value) continue;
      const cur = normalize(value);
      let score = 0;
      if (cur === req) score += 400;
      if (req === "auto" && cur === "auto") score += 450;
      if (cur.includes(req)) score += 220;
      if (req.includes(cur)) score += 180;
      for (const word of reqWords) {
        if (word.length >= 2 && cur.includes(word)) score += 35;
      }
      if (!best || score > best.score) best = { value, score };
    }
    return best && best.score > 0 ? best.value : null;
  }

  private async selectModelOption(client: ClientDomains, optionText: string): Promise<boolean> {
    const expression = `(() => {
      const target = ${JSON.stringify(optionText)}.toLowerCase().replace(/\\s+/g, ' ').trim();
      const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const rows = Array.from(document.querySelectorAll('[role="option"],[role="menuitem"],.monaco-list-row,.quick-input-list-entry,li,button,a'))
        .filter(isVisible);
      const ranked = rows
        .map((el) => {
          const txt = normalize(el.textContent || el.getAttribute('aria-label') || '');
          if (!txt) return null;
          const exact = txt === target;
          const contains = txt.includes(target) || target.includes(txt);
          if (!exact && !contains) return null;
          let score = exact ? 200 : 120;
          const role = normalize(el.getAttribute('role') || '');
          if (role === 'option' || role === 'menuitem') score += 20;
          const clickable = el.closest('button,a,[role="option"],[role="menuitem"],[role="button"],li,div') || el;
          return { clickable, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
      const best = ranked[0]?.clickable;
      if (!best || typeof best.click !== 'function') return false;
      best.click();
      return true;
    })();`;
    return Boolean(await this.cdp.evaluateJson<boolean>(client, expression));
  }

  private async waitForModelConfirmation(client: ClientDomains, expected: string, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await this.readCurrentModelLabel(client);
      if (current && this.modelNameMatches(current, expected)) {
        return current;
      }
      await wait(160);
    }
    return null;
  }

  private modelNameMatches(current: string, expected: string): boolean {
    const normalize = (v: string) => String(v || "").toLowerCase().replace(/\s+/g, " ").trim();
    const c = normalize(current);
    const e = normalize(expected);
    return c === e || c.includes(e) || e.includes(c);
  }

  private async safeClosePicker(client: ClientDomains): Promise<void> {
    try {
      if (await this.isQuickPickVisible(client)) {
        await this.cdp.sendShortcut(client, "Escape", "Escape", 27, 0);
        await wait(100);
      }
    } catch {
      // best-effort
    }
  }

  private async collectModelsByCycling(
    client: ClientDomains,
    startingLabel: string | null,
    maxSteps: number
  ): Promise<string[]> {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (v: string | null) => {
      const text = String(v || "").trim();
      if (!text) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(text);
    };

    add(startingLabel);
    let current = startingLabel;
    for (let i = 0; i < maxSteps; i += 1) {
      const advanced = await this.advanceModelOnce(client);
      if (!advanced) break;
      await wait(220);
      current = await this.readCurrentModelLabel(client);
      add(current);
      if (current && startingLabel && this.modelNameMatches(current, startingLabel) && out.length > 1) {
        break;
      }
    }

    if (startingLabel && !this.modelNameMatches(current || "", startingLabel)) {
      // best-effort restore to the user's previous model after probing.
      await this.setModelByLabelBestEffort(client, startingLabel);
    }
    return out;
  }

  private async advanceModelOnce(client: ClientDomains): Promise<boolean> {
    const opened = await this.openModelPicker(client);
    if (!opened) return false;
    if (await this.isQuickPickVisible(client)) {
      await this.cdp.sendShortcut(client, "ArrowDown", "ArrowDown", 40, 0);
      await wait(120);
      await this.cdp.sendShortcut(client, "Enter", "Enter", 13, 0);
      return true;
    }

    const before = await this.readCurrentModelLabel(client);
    const clicked = await this.clickModelTrigger(client);
    if (!clicked) return false;
    await wait(180);
    const after = await this.readCurrentModelLabel(client);
    return Boolean(after && before && !this.modelNameMatches(before, after));
  }

  private async clickModelTrigger(client: ClientDomains): Promise<boolean> {
    const expression = `(() => {
      const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const configuredSelector = ${JSON.stringify(config.vscodeModelSelector || "")};
      const ranked = [];
      if (configuredSelector) {
        try {
          for (const el of Array.from(document.querySelectorAll(configuredSelector))) {
            if (!isVisible(el)) continue;
            const clickable = el.closest('a,button,[role="button"],[role="menuitem"]') || el;
            ranked.push({ clickable, score: 500 });
          }
        } catch {
          // ignore invalid selector in best-effort mode
        }
      }
      for (const el of Array.from(document.querySelectorAll('a,button,[role="button"],[role="menuitem"]')).filter(isVisible)) {
        const text = normalize(
          (el.textContent || '') + ' ' +
          (el.getAttribute('aria-label') || '') + ' ' +
          (el.getAttribute('title') || '') + ' ' +
          (el.className || '')
        );
        let score = 0;
        if (text.includes('model')) score += 260;
        if (text.includes('set agent')) score -= 220;
        if (text.includes('new chat')) score -= 120;
        if (text.includes('auto') || text.includes('claude') || text.includes('gpt') || text.includes('sonnet')) score += 160;
        const li = el.closest('li');
        const liIndex = li && li.parentElement ? (Array.from(li.parentElement.children).indexOf(li) + 1) : 0;
        if (liIndex === 3) score += 75;
        if (score > 0) ranked.push({ clickable: el, score });
      }
      ranked.sort((a, b) => b.score - a.score);
      const best = ranked[0]?.clickable;
      if (!best || typeof best.click !== 'function') return false;
      best.click();
      return true;
    })();`;
    return Boolean(await this.cdp.evaluateJson<boolean>(client, expression));
  }

  private async setModelByLabelBestEffort(client: ClientDomains, modelLabel: string): Promise<boolean> {
    const opened = await this.openModelPicker(client);
    if (!opened) return false;
    const options = await this.readVisibleModelOptions(client);
    const target = this.pickBestModelOption(options, modelLabel);
    if (!target) {
      await this.safeClosePicker(client);
      return false;
    }
    const clicked = await this.selectModelOption(client, target);
    await this.safeClosePicker(client);
    if (!clicked) return false;
    const after = await this.waitForModelConfirmation(client, modelLabel, 1800);
    return Boolean(after);
  }
}
