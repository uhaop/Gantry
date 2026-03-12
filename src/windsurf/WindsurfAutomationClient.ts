import { exec } from "node:child_process";
import { promisify } from "node:util";
import { BridgeMode, BridgeResponse } from "../types";
import { logger } from "../logger";
import { config } from "../config";
import { ClientDomains, CdpTargetSummary, wait } from "../cdp/BaseCdpClient";
import { WindsurfCdpClient } from "./WindsurfCdpClient";

const execAsync = promisify(exec);
type DetectedMode = "Code" | "Ask" | "Plan" | "Write" | "Chat";

/**
 * Windsurf / Cascade integration via CDP.
 * Mirrors CursorAutomationClient interface but uses Cascade-specific selectors and patterns.
 */
export class WindsurfAutomationClient {
  private readonly cdp = new WindsurfCdpClient();
  private readonly modeLabelAliases: Record<BridgeMode, string[]> = {
    ask: ["Ask", "Chat"],
    code: ["Code", "Write"],
    plan: ["Plan"],
    debug: []
  };

  async listChatTargets(): Promise<CdpTargetSummary[]> {
    try {
      return await this.cdp.listTargets();
    } catch (error) {
      logger.warn({ error }, "Failed to list Windsurf targets through CDP");
      return [];
    }
  }

  async targetSelectionStatus(): Promise<{
    mode: "auto" | "manual";
    manualTargetId: string | null;
    manualTargetTitle: string | null;
  }> {
    try {
      return await this.cdp.getSelectionState();
    } catch (error) {
      logger.warn({ error }, "Failed to read Windsurf target selection state");
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
    if (mode === "debug") {
      return {
        text: "Debug mode is not available in Windsurf. Available modes: ask, code, plan.",
        metadata: { status: "unsupported" }
      };
    }

    const aliases = this.modeLabelAliases[mode];

    logger.info({ mode }, "Requested Windsurf mode switch");

    try {
      const switched = await this.cdp.withClient(async (client): Promise<{ ok: boolean; detectedMode: string | null }> => {
        const focused = await this.focusChatInput(client);
        if (!focused) {
          logger.info({ mode }, "Mode switch: chat input not focusable");
          return { ok: false, detectedMode: null };
        }

        const initialMode = await this.detectCurrentMode(client);
        logger.info({ mode, initialMode }, "Mode switch: initial detection");
        if (initialMode && aliases.includes(initialMode)) {
          return { ok: true, detectedMode: initialMode };
        }

        // Cascade uses a dropdown for mode selection — click it open, then pick option
        const clicked = await this.clickModeOption(client, aliases);
        if (clicked) {
          await wait(250);
          const afterClickMode = await this.detectCurrentMode(client);
          logger.info({ mode, aliases, afterClickMode }, "Mode switch: click attempt result");
          if (afterClickMode && aliases.includes(afterClickMode)) {
            return { ok: true, detectedMode: afterClickMode };
          }
        }

        const finalDetected = await this.detectCurrentMode(client);
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
      logger.warn({ error, mode }, "CDP mode switching failed for Windsurf");
      return {
        text: `Mode switch failed through CDP for ${mode}.`,
        metadata: { mapped_to: aliases.join("/"), status: "failed" }
      };
    }
  }

  async sendPrompt(
    prompt: string,
    _options?: { preferAttachmentComposer?: boolean; attachmentKind?: "photo" | "document"; attachmentFileName?: string }
  ): Promise<BridgeResponse> {
    logger.info({ length: prompt.length }, "Windsurf prompt relay requested");

    try {
      const relayResult = await this.cdp.withClient(async (client) => {
        const focused = await this.focusChatInput(client);
        if (!focused) {
          return { delivered: false, responseSnippet: null as string | null };
        }

        const baselineSnippet = await this.readLatestAssistantSnippet(client);
        const injected = await this.injectPromptText(client, prompt);
        if (!injected) {
          return { delivered: false, responseSnippet: null as string | null };
        }

        await this.cdp.sendShortcut(client, "Enter", "Enter", 13, 0);
        const responseSnippet = await this.pollLatestAssistantSnippet(client, config.windsurfActionTimeoutMs, baselineSnippet);
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
      logger.warn({ error }, "CDP prompt relay failed for Windsurf");
      return {
        text: "Prompt relay failed through CDP. Check Windsurf remote debugging endpoint and target selection.",
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
      logger.warn({ error }, "Failed reading latest Cascade assistant snippet");
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
      logger.warn({ error }, "Windsurf CDP model detection failed");
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
      logger.warn({ error, modelName }, "Windsurf CDP model switching failed");
      return { text: `Model switch failed through CDP for "${modelName}".`, metadata: { status: "failed" } };
    }
  }

  async listModels(): Promise<BridgeResponse> {
    try {
      // Temporary: hide model list while scraping is being improved
      return {
        text: "Model list is being improved. Please pick your model directly in Windsurf for now.",
        metadata: { status: "wip" }
      };
    } catch (error) {
      logger.warn({ error }, "Windsurf CDP model listing failed");
      return { text: "Model listing failed through CDP.", metadata: { status: "failed" } };
    }
  }

  async newChat(): Promise<BridgeResponse> {
    try {
      const shortcutResult = await this.cdp.withClient(async (client) => {
        const isMac = process.platform === "darwin";
        const modifiers = isMac ? 12 /* Meta+Shift */ : 10 /* Ctrl+Shift */;
        await this.cdp.sendShortcut(client, "l", "KeyL", 76, modifiers);
        await wait(200);
        const focused = await this.focusChatInput(client);
        return { focused };
      });

      return {
        text: shortcutResult.focused
          ? "New chat shortcut (Ctrl+Shift+L) sent in Windsurf. Chat input is focusable."
          : "New chat shortcut (Ctrl+Shift+L) sent in Windsurf, but chat input was not focusable afterward.",
        metadata: { status: shortcutResult.focused ? "ok" : "failed", focused: shortcutResult.focused }
      };
    } catch (error) {
      logger.warn({ error }, "CDP new chat dispatch failed for Windsurf; falling back to OS send keys");
    }

    try {
      await execAsync(
        "powershell -NoProfile -Command \"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^l')\""
      );
      return {
        text: "Windsurf new chat dispatched via OS shortcut (Ctrl+L). Chat input focus not verified.",
        metadata: { status: "dispatched" }
      };
    } catch (error) {
      logger.warn({ error }, "Windsurf new chat shortcut dispatch failed");
      return { text: "New chat dispatch failed; manual fallback required.", metadata: { status: "failed" } };
    }
  }

  private async clickNewConversationButton(
    client: ClientDomains
  ): Promise<{ clicked: boolean; found: number; label: string | null; reason: string | null }> {
    const expression = `(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
      };

      const getLabel = (el) => {
        const aria = el.getAttribute?.('aria-label') || '';
        const title = el.getAttribute?.('title') || '';
        const text = (el.textContent || '').trim();
        return [aria, title, text].filter(Boolean).join(' ').trim();
      };

      // Top-right tab bar region where the + lives
      const isTopRightTabBar = (el) => {
        const rect = el.getBoundingClientRect();
        const nearTop = rect.top >= 0 && rect.top < window.innerHeight * 0.3;
        const nearRight = rect.left > window.innerWidth * 0.4;
        const reasonableSize = rect.width > 8 && rect.width < 140 && rect.height > 8 && rect.height < 120;
        return nearTop && nearRight && reasonableSize;
      };

      // Fast path: exact start new conversation control (only if in sidebar zone)
      const direct = Array.from(
        document.querySelectorAll(
          'button[aria-label*="start a new conversation" i], [role="button"][aria-label*="start a new conversation" i], [title*="start a new conversation" i]'
        )
      ).find((el) => isVisible(el) && isTopRightTabBar(el));
      if (direct) {
        const fire = (type) => direct.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        fire('mousedown');
        fire('mouseup');
        fire('click');
        return { clicked: true, found: 1, label: getLabel(direct), reason: null };
      }

      const candidates = Array.from(
        document.querySelectorAll('button, [role="button"], [aria-label], a, div, span')
      ).filter((el) => isVisible(el) && isTopRightTabBar(el));

      const scored = candidates
        .map((el) => {
          const rawLabel = getLabel(el);
          const label = rawLabel.toLowerCase();
          const text = (el.textContent || '').trim();
          const textLen = text.length;
          const rect = el.getBoundingClientRect();

          // Hard filter: ignore huge labels or unrelated long text blobs
          if (rawLabel.length > 80 || textLen > 40) {
            return { el, label: rawLabel, score: 0 };
          }

          // Ignore very large elements (likely panels/content areas)
          if (rect.width > 220 || rect.height > 160) {
            return { el, label: rawLabel, score: 0 };
          }

          let score = 0;
          const hasNewKeyword = label.includes('start a new conversation') || label.includes('new conversation') || label.includes('new chat');
          const isPlus = text === '+' || (text.startsWith('+') && textLen <= 3);
          const shortNewText = textLen > 0 && textLen <= 12 && text.toLowerCase().includes('new');

          if (hasNewKeyword) score += 200;
          if (label.includes('new conversation')) score += 80;
          if (label.includes('new chat')) score += 60;
          if (isPlus) score += 140;
          if (shortNewText) score += 100;

          // Require some explicit signal of '+' or 'new'
          if (!(hasNewKeyword || isPlus || shortNewText)) {
            return { el, label: rawLabel, score: 0 };
          }

          // Require it to be in a chat-like container
          const ancestor = el.closest('[class*="chat"], [class*="cascade"], [class*="panel"], [class*="history"]');
          if (!ancestor) {
            return { el, label: rawLabel, score: 0 };
          }
          score += 80;

          // Strong bias toward top-left placement
          if (rect.top < window.innerHeight * 0.6) score += 40;

          return { el, label: rawLabel, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);

      const target = scored[0];
      if (!target) {
        return { clicked: false, found: candidates.length, reason: 'no-candidate', label: null };
      }

      // Fire mouse events to improve activation reliability
      const fire = (type) => target.el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      fire('mousedown');
      fire('mouseup');
      fire('click');
      return { clicked: true, found: candidates.length, label: target.label || null, reason: null };
    })();`;

    const result = await this.cdp.evaluateJson<{ clicked: boolean; found: number; label: string | null; reason: string | null }>(
      client,
      expression
    );

    return (
      result ?? {
        clicked: false,
        found: 0,
        reason: "evaluation-null",
        label: null
      }
    );
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
      fallbackTextboxCandidates: number;
      fallbackResponseCandidates: number;
      newChatCandidates: number;
      newChatBestLabel: string | null;
    };
  }> {
    const notes: string[] = [];
    const configuredSelectors = {
      chatInput: config.windsurfChatInputSelector,
      response: config.windsurfResponseSelector
    };

    let versionEndpointReachable = false;
    try {
      const version = await this.cdp.readVersionInfo();
      versionEndpointReachable = Boolean(version?.webSocketDebuggerUrl);
      if (!versionEndpointReachable) {
        notes.push("Version endpoint reachable but webSocketDebuggerUrl missing.");
      }
    } catch (error) {
      logger.warn({ error }, "Windsurf CDP version endpoint check failed");
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
            fallbackTextboxCandidates: 0,
            fallbackResponseCandidates: 0,
            newChatCandidates: 0,
            newChatBestLabel: null
          }
        };
      }

      const runtimeCheck = await this.cdp.withClient(async (client, target) => {
        const focusable = await this.focusChatInput(client);
        const mode = await this.detectCurrentMode(client);
        const selectorHealth = await this.readSelectorHealth(client);
        return {
          selectedTargetTitle: target.title,
          chatInputFocusable: focusable,
          detectedMode: mode,
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
      logger.warn({ error }, "Windsurf CDP runtime diagnostics failed");
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
          fallbackTextboxCandidates: 0,
          fallbackResponseCandidates: 0,
          newChatCandidates: 0,
          newChatBestLabel: null
        }
      };
    }
  }

  private async readSelectorHealth(client: ClientDomains): Promise<{
    configuredChatInputMatches: number;
    configuredResponseMatches: number;
    fallbackTextboxCandidates: number;
    fallbackResponseCandidates: number;
    newChatCandidates: number;
    newChatBestLabel: string | null;
  }> {
    const expression = `
      (() => {
        const configuredChat = ${JSON.stringify(config.windsurfChatInputSelector)};
        const configuredResp = ${JSON.stringify(config.windsurfResponseSelector)};
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
          '[class*="text-ide-message-block-bot-color"],[class*="prose"],[class*="markdown-renderer"],article,[role="article"]'
        ).length;

        const newChatCandidates = Array.from(
          document.querySelectorAll('button, [role="button"], [aria-label], a, div, span')
        ).filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 3 &&
            rect.height > 3 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none'
          );
        });

        const labelFor = (el) => {
          const aria = el.getAttribute?.('aria-label') || '';
          const title = el.getAttribute?.('title') || '';
          const text = (el.textContent || '').trim();
          return [aria, title, text].filter(Boolean).join(' ').trim();
        };

        const scoredNewChat = newChatCandidates
          .map((el) => {
            const rawLabel = labelFor(el);
            const label = rawLabel.toLowerCase();
            const text = (el.textContent || '').trim();
            const textLen = text.length;

            if (rawLabel.length > 80 || textLen > 40) {
              return { score: 0, label: rawLabel };
            }

            const rect = el.getBoundingClientRect();
            if (!(rect.top >= 0 && rect.top < window.innerHeight * 0.3 && rect.left > window.innerWidth * 0.4)) {
              return { score: 0, label: rawLabel };
            }
            if (rect.width > 140 || rect.height > 120) {
              return { score: 0, label: rawLabel };
            }

            let score = 0;
            const hasNewKeyword = label.includes('start a new conversation') || label.includes('new conversation') || label.includes('new chat');
            const isPlus = text === '+' || (text.startsWith('+') && textLen <= 3);
            const shortNewText = textLen > 0 && textLen <= 12 && text.toLowerCase().includes('new');

            if (hasNewKeyword) score += 200;
            if (label.includes('new conversation')) score += 80;
            if (label.includes('new chat')) score += 60;
            if (isPlus) score += 140;
            if (shortNewText) score += 100;

            if (!(hasNewKeyword || isPlus || shortNewText)) {
              return { score: 0, label: rawLabel };
            }

            const ancestor = el.closest('[class*="chat"], [class*="cascade"], [class*="panel"], [class*="history"]');
            if (ancestor) score += 60;

            return { score, label: rawLabel };
          })
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score);

        const bestLabelRaw = scoredNewChat[0]?.label || null;
        const newChatBestLabel = bestLabelRaw ? bestLabelRaw.slice(0, 80) : null;

        return {
          configuredChatInputMatches: count(configuredChat),
          configuredResponseMatches: count(configuredResp),
          fallbackTextboxCandidates: fallbackTextbox,
          fallbackResponseCandidates: fallbackResponse,
          newChatCandidates: scoredNewChat.length,
          newChatBestLabel
        };
      })();
    `;
    const result = await this.cdp.evaluateJson<{
      configuredChatInputMatches: number;
      configuredResponseMatches: number;
      fallbackTextboxCandidates: number;
      fallbackResponseCandidates: number;
      newChatCandidates: number;
      newChatBestLabel: string | null;
    }>(client, expression);
    return {
      configuredChatInputMatches: result?.configuredChatInputMatches ?? -1,
      configuredResponseMatches: result?.configuredResponseMatches ?? -1,
      fallbackTextboxCandidates: result?.fallbackTextboxCandidates ?? 0,
      fallbackResponseCandidates: result?.fallbackResponseCandidates ?? 0,
      newChatCandidates: result?.newChatCandidates ?? 0,
      newChatBestLabel: result?.newChatBestLabel ?? null
    };
  }

  private async focusChatInput(client: ClientDomains): Promise<boolean> {
    const selectorLiteral = JSON.stringify(config.windsurfChatInputSelector);
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
          const matches = Array.from(document.querySelectorAll(configured)).filter(isVisible);
          // Cascade chat textbox: prefer the one inside the chat panel (not terminal xterm textareas)
          const chatTextbox = matches.find(el => {
            const cls = String(el.className || '').toLowerCase();
            const parentCls = String(el.parentElement?.className || '').toLowerCase();
            const ancestorCls = String(el.closest('[class*="ide-input-color"],[class*="chat"],[class*="cascade"]')?.className || '').toLowerCase();
            // Exclude terminal xterm textareas
            if (cls.includes('xterm')) return false;
            if (parentCls.includes('xterm')) return false;
            return true;
          });
          if (chatTextbox) {
            chatTextbox.focus();
            return true;
          }
        }

        // Fallback: find visible textbox/contenteditable that looks like a chat input
        const candidates = [
          ...Array.from(document.querySelectorAll('[role="textbox"]')),
          ...Array.from(document.querySelectorAll('[contenteditable="true"]')),
          ...Array.from(document.querySelectorAll('textarea'))
        ].filter(isVisible);

        if (candidates.length === 0) return false;

        const score = (el) => {
          const rect = el.getBoundingClientRect();
          const className = String(el.className || '').toLowerCase();
          const parentClassName = String(el.parentElement?.className || '').toLowerCase();
          let value = 0;
          // Exclude terminal textareas
          if (className.includes('xterm') || parentClassName.includes('xterm')) value -= 1000;
          // Prefer elements with chat/input related classes
          if (className.includes('outline-none')) value += 100;
          if (el.closest('[class*="ide-input-color"]')) value += 200;
          if (el.closest('[class*="chat"]')) value += 150;
          if (el.getAttribute('role') === 'textbox') value += 80;
          // Prefer elements lower in viewport (chat input area)
          value += Math.min(180, Math.max(0, rect.top));
          // Penalize huge editor areas
          value -= Math.min(220, Math.round((rect.width * rect.height) / 4000));
          return value;
        };

        candidates.sort((a, b) => score(b) - score(a));
        candidates[0].focus();
        return document.activeElement === candidates[0];
      })();
    `;

    const focused = await this.cdp.evaluateJson<boolean>(client, expression);
    return focused === true;
  }

  private async detectCurrentMode(client: ClientDomains): Promise<DetectedMode | null> {
    const expression = `
      (() => {
        const modeMatchers = [
          { label: 'Code', key: 'code' },
          { label: 'Ask', key: 'ask' },
          { label: 'Plan', key: 'plan' },
          { label: 'Write', key: 'write' },
          { label: 'Chat', key: 'chat' }
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

        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const clickElement = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const target = document.elementFromPoint(x, y) || el;
          for (const node of [target, el]) {
            node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
            node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
            node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, button: 0 }));
            node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0 }));
            node.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, button: 0 }));
          }
          return true;
        };

        // Cascade mode dropdown: a button near the chat input that shows current mode
        const buttons = Array.from(document.querySelectorAll('button')).filter(isVisible);

        // Pass 1: buttons with data-state containing mode text (older Windsurf versions)
        for (const button of buttons) {
          const dataState = button.getAttribute('data-state');
          if (dataState === null) continue;
          const text = normalize([
            button.textContent || '',
            button.getAttribute('aria-label') || '',
            button.getAttribute('title') || ''
          ].join(' '));
          const mode = modeFromText(text);
          if (mode) return mode;
        }

        // Pass 2: buttons with short text that IS a mode label (current Windsurf UI)
        // The mode button is a plain <button> with a <span class="text">Chat</span> child
        for (const button of buttons) {
          const fullText = normalize(button.textContent || '');
          // Skip buttons with long text (e.g. "ChatCtrl+L" sidebar shortcut)
          if (fullText.length > 12) continue;
          const mode = modeFromText(fullText);
          if (mode) {
            // Verify it looks like a mode selector (near viewport, not in sidebar)
            const rect = button.getBoundingClientRect();
            if (rect.y > 0 && rect.y < window.innerHeight) return mode;
          }
          // Also check child spans with class "text"
          const textSpan = button.querySelector('span.text');
          if (textSpan) {
            const spanMode = modeFromText(textSpan.textContent || '');
            if (spanMode) {
              const rect = button.getBoundingClientRect();
              if (rect.y > 0 && rect.y < window.innerHeight) return spanMode;
            }
          }
        }

        // Pass 3: scan any visible elements with selected/active state that match mode labels
        const allElements = Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"]')).filter(isVisible);
        for (const el of allElements) {
          const text = normalize([
            el.textContent || '',
            el.getAttribute('aria-label') || ''
          ].join(' '));
          if (text.length > 30) continue;
          const mode = modeFromText(text);
          if (mode) {
            const className = normalize(el.className || '');
            const pressed = normalize(el.getAttribute('aria-pressed') || '');
            const selectedByAttr =
              pressed === 'true' ||
              normalize(el.getAttribute('data-state') || '') === 'active' ||
              normalize(el.getAttribute('data-state') || '') === 'selected' ||
              normalize(el.getAttribute('aria-current') || '') === 'true';
            const selectedByClass =
              className.includes('selected') ||
              className.includes('active') ||
              className.includes('current');
            if (selectedByAttr || selectedByClass) return mode;
          }
        }

        return null;
      })();
    `;
    return await this.cdp.evaluateJson<DetectedMode | null>(client, expression);
  }

  private async clickModeOption(client: ClientDomains, preferredLabels: string[]): Promise<boolean> {
    const labelsLiteral = JSON.stringify(preferredLabels);
    const expression = `
      (async () => {
        const preferred = ${labelsLiteral}.map((x) => String(x || '').toLowerCase());
        const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        const modeMatchers = [
          { label: 'code', key: 'code' },
          { label: 'ask', key: 'ask' },
          { label: 'plan', key: 'plan' },
          { label: 'write', key: 'write' },
          { label: 'chat', key: 'chat' }
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
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const clickElement = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const target = document.elementFromPoint(x, y) || el;
          for (const node of [target, el]) {
            node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
            node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
            node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, button: 0 }));
            node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0 }));
            node.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, button: 0 }));
          }
          return true;
        };

        // Step 1: Find and click the mode dropdown button to open menu
        const buttons = Array.from(document.querySelectorAll('button')).filter(isVisible);
        let dropdownButton = null;
        let currentMode = null;

        // Pass A: buttons with data-state containing mode text (older Windsurf)
        for (const button of buttons) {
          const dataState = button.getAttribute('data-state');
          if (dataState === null) continue;
          const text = normalize([
            button.textContent || '',
            button.getAttribute('aria-label') || '',
            button.getAttribute('title') || ''
          ].join(' '));
          const mode = modeFromText(text);
          if (mode) {
            if (preferred.includes(mode)) return true;
            dropdownButton = button;
            currentMode = mode;
            break;
          }
        }

        // Pass B: buttons with short mode text or span.text child (current Windsurf)
        if (!dropdownButton) {
          for (const button of buttons) {
            const fullText = normalize(button.textContent || '');
            let mode = null;
            if (fullText.length <= 12) {
              mode = modeFromText(fullText);
            }
            if (!mode) {
              const textSpan = button.querySelector('span.text');
              if (textSpan) {
                mode = modeFromText(textSpan.textContent || '');
              }
            }
            if (mode) {
              const rect = button.getBoundingClientRect();
              if (rect.y > 0 && rect.y < window.innerHeight) {
                if (preferred.includes(mode)) return true;
                dropdownButton = button;
                currentMode = mode;
                break;
              }
            }
          }
        }

        if (!dropdownButton) return false;

        // Click to open the dropdown
        clickElement(dropdownButton);
        await sleep(300);

        const dr = dropdownButton.getBoundingClientRect();
        const openDialog = Array.from(document.querySelectorAll('[role="dialog"]')).find((el) => {
          if (!isVisible(el)) return false;
          const rect = el.getBoundingClientRect();
          return Math.abs(rect.left - dr.left) <= 80 && rect.bottom <= dr.bottom + 40 && rect.top >= dr.top - 220;
        });

        const searchRoot = openDialog || document;
        const optionNodes = Array.from(
          searchRoot.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],div,span,a')
        ).filter((el) => isVisible(el) && el !== dropdownButton);

        for (const preferredLabel of preferred) {
          const hit = optionNodes.find((el) => {
            const text = normalize([
              el.textContent || '',
              el.getAttribute('aria-label') || '',
              el.getAttribute('title') || ''
            ].join(' '));
            const mode = modeFromText(text);
            if (mode !== preferredLabel) return false;
            const er = el.getBoundingClientRect();
            const insideDialog = !openDialog || openDialog.contains(el);
            const near = Math.abs(er.left - dr.left) <= 260 && Math.abs(er.top - dr.top) <= 260;
            return insideDialog && near;
          });
          if (hit) {
            const clickableAncestor = [hit, hit.parentElement, hit.parentElement?.parentElement].find((node) => {
              if (!node || !isVisible(node)) return false;
              if (openDialog && !openDialog.contains(node)) return false;
              const rect = node.getBoundingClientRect();
              return rect.height >= 16 && rect.height <= 60 && rect.width >= 40;
            });
            if (clickElement(clickableAncestor || hit)) {
              await sleep(200);
              return true;
            }
          }
        }

        return false;
      })();
    `;
    return (await this.cdp.evaluateJson<boolean>(client, expression)) === true;
  }

  private async detectCurrentModel(client: ClientDomains): Promise<string | null> {
    const modelSelectorLiteral = JSON.stringify(config.windsurfModelSelector);
    const expression = `
      (() => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const clean = (value) => {
          let raw = normalize(value);
          if (!raw) return '';
          raw = raw.replace(/\s*(new|free|pro|max|\d+(\.\d+)?x|✓)\s*$/i, '').trim();
          const parts = raw.split(' ').filter(Boolean);
          while (parts.length > 1) {
            const last = parts[parts.length - 1].toLowerCase();
            if (last === 'new' || last === 'free' || last === 'pro' || /^\d+(\.\d+)?x$/.test(last) || last === '✓') {
              parts.pop();
              continue;
            }
            break;
          }
          return parts.join(' ');
        };
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
        };

        const modelKeywords = ['claude', 'gpt', 'sonnet', 'opus', 'haiku', 'o1', 'o3', 'o4', 'gemini', 'deepseek', 'llama', 'auto', 'turbo', '4o', 'thinking', 'grok', 'codex'];

        // 1) Status bar / current model chip near chat input (bottom bar)
        const statusNodes = Array.from(document.querySelectorAll('button,span,div,a')).filter(isVisible);
        for (const el of statusNodes) {
          const text = normalize(el.textContent || '');
          if (!text || text.length > 120) continue;
          const lower = text.toLowerCase();
          if (!modelKeywords.some((k) => lower.includes(k))) continue;
          // prefer nodes near bottom of viewport (status bar area)
          const rect = el.getBoundingClientRect();
          if (rect.top > window.innerHeight - 240) {
            const label = clean(text);
            if (label) return label;
          }
        }

        // 2) Configured model selector
        const configured = ${modelSelectorLiteral};
        if (configured) {
          const matches = Array.from(document.querySelectorAll(configured)).filter(isVisible);
          for (const el of matches) {
            const text = clean(el.textContent || '');
            if (text && text.length < 120) return text;
          }
        }

        // 3) Buttons near chat panel containing model keywords
        const buttons = Array.from(document.querySelectorAll('button')).filter(isVisible);
        for (const btn of buttons) {
          const text = clean(btn.textContent || '').toLowerCase();
          if (text.length > 120 || text.length < 3) continue;
          const hasModelWord = modelKeywords.some((k) => text.includes(k));
          if (!hasModelWord) continue;
          const inPanel = btn.closest('[class*="panel-bg"],[class*="text-ide-"],[class*="shadow-menu"]');
          if (inPanel) return clean(btn.textContent || '');
        }

        // 4) Spans inside buttons as broad fallback
        const spans = Array.from(document.querySelectorAll('button span')).filter(isVisible);
        for (const span of spans) {
          const text = clean(span.textContent || '').toLowerCase();
          if (text.length > 120 || text.length < 3) continue;
          if (modelKeywords.some((k) => text.includes(k))) {
            return clean(span.textContent || '');
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
    const modelSelectorLiteral = JSON.stringify(config.windsurfModelSelector);
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
        const modelKeywords = ['claude', 'gpt', 'sonnet', 'opus', 'haiku', 'o1', 'o3', 'o4', 'gemini', 'deepseek', 'llama', 'auto', 'turbo', '4o', 'thinking', 'grok', 'swe'];

        // Find the model button
        const configured = ${modelSelectorLiteral};
        let modelBtn = null;
        if (configured) {
          const matches = Array.from(document.querySelectorAll(configured)).filter(isVisible);
          modelBtn = matches[0] || null;
        }
        if (!modelBtn) {
          const buttons = Array.from(document.querySelectorAll('button')).filter(isVisible);
          for (const btn of buttons) {
            const text = lower(btn.textContent || '');
            if (text.length > 80 || text.length < 3) continue;
            if (modelKeywords.some(k => text.includes(k))) {
              const inPanel = btn.closest('[class*="panel-bg"],[class*="text-ide-"],[class*="shadow-menu"]');
              if (inPanel) { modelBtn = btn; break; }
            }
          }
        }
        if (!modelBtn) return { ok: false, selectedModel: null };

        // Check if already on target
        const currentText = lower(modelBtn.textContent || '');
        if (currentText.includes(target)) {
          return { ok: true, selectedModel: normalize(modelBtn.textContent || '') };
        }

        // Click to open model selector
        modelBtn.click();

        // Search for matching option
        const br = modelBtn.getBoundingClientRect();
        const optionNodes = Array.from(
          document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],div,span,a,li')
        ).filter(isVisible);

        const scored = optionNodes
          .map((el) => {
            const text = lower(el.textContent || '');
            if (text.length > 80 || text.length < 2) return null;
            const er = el.getBoundingClientRect();
            const near = Math.abs(er.left - br.left) <= 500 && Math.abs(er.top - br.top) <= 600;
            if (!near) return null;
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

        document.body.click();
        return { ok: false, selectedModel: normalize(modelBtn.textContent || '') };
      })();
    `;
    const result = await this.cdp.evaluateJson<{ ok: boolean; selectedModel: string | null }>(client, expression);
    return result ?? { ok: false, selectedModel: null };
  }

  private async listAvailableModels(client: ClientDomains): Promise<string[]> {
    const modelSelectorLiteral = JSON.stringify(config.windsurfModelSelector);
    const expression = `
      (async () => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const lower = (value) => normalize(value).toLowerCase();
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const inViewport = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
        };
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const modelKeywords = ['claude', 'gpt', 'sonnet', 'opus', 'haiku', 'o1', 'o3', 'o4', 'gemini', 'deepseek', 'llama', 'auto', 'turbo', '4o', 'thinking', 'grok', 'swe'];
        const cleanModelLabel = (value) => {
          let raw = normalize(value);
          if (!raw) return '';
          // Strip trailing badge-like suffixes, including compressed variants like "New2x"
          for (let i = 0; i < 3; i++) {
            raw = raw.replace(/\s*(new\s*\d*(\.\d+)?x?|free|pro|max|\d+(\.\d+)?x|✓)\s*$/i, '').trim();
          }
          const parts = raw.split(' ').filter(Boolean);
          while (parts.length > 1) {
            const last = parts[parts.length - 1].toLowerCase();
            if (last === 'new' || last === 'free' || last === 'pro' || /^\d+(\.\d+)?x$/.test(last) || last === '✓') {
              parts.pop();
              continue;
            }
            break;
          }
          return parts.join(' ');
        };

        const configured = ${modelSelectorLiteral};
        let modelBtn = null;
        if (configured) {
          const matches = Array.from(document.querySelectorAll(configured)).filter((el) => isVisible(el) && inViewport(el));
          modelBtn = matches[0] || null;
        }
        if (!modelBtn) {
          const buttons = Array.from(document.querySelectorAll('button')).filter(isVisible);
          let bestScore = -Infinity;
          for (const btn of buttons) {
            const text = lower(btn.textContent || '');
            if (text.length > 80 || text.length < 3) continue;
            if (!inViewport(btn)) continue;
            if (modelKeywords.some((keyword) => text.includes(keyword))) {
              const inPanel = btn.closest('[class*="panel-bg"],[class*="text-ide-"],[class*="shadow-menu"]');
              if (inPanel) {
                const rect = btn.getBoundingClientRect();
                let score = 0;
                if (rect.top > window.innerHeight - 180) score += 200;
                if (rect.left > window.innerWidth - 420) score += 150;
                if (text.length <= 40) score += 80;
                if (!text.includes('mode')) score += 30;
                if (score > bestScore) {
                  bestScore = score;
                  modelBtn = btn;
                }
              }
            }
          }
        }
        if (!modelBtn) return [];

        modelBtn.click();
        await sleep(300);

        const br = modelBtn.getBoundingClientRect();
        const pickerRoot = (() => {
          const candidates = Array.from(document.querySelectorAll('div,section,aside'))
            .filter((el) => isVisible(el) && inViewport(el))
            .map((el) => {
              const rect = el.getBoundingClientRect();
              const text = lower(el.textContent || '');
              let score = 0;
              if (text.includes('search all models')) score += 500;
              if (text.includes('recently used')) score += 300;
              if (text.includes('recommended')) score += 150;
              if (modelKeywords.some((keyword) => text.includes(keyword))) score += 100;
              if (Math.abs(rect.left - br.left) <= 200) score += 120;
              if (Math.abs(rect.top - br.top) <= 820) score += 120;
              if (rect.width >= 200 && rect.width <= 720) score += 80;
              if (rect.height >= 160 && rect.height <= 920) score += 80;
              return { el, rect, text, score };
            })
            .sort((a, b) => b.score - a.score);
          if (candidates.length === 0) return null;
          // Prefer reasonably high score but still fall back to best candidate
          return candidates.find((item) => item.score >= 220)?.el || candidates[0].el;
        })();

        const searchRoot = pickerRoot || document;
        const rootRect = pickerRoot ? pickerRoot.getBoundingClientRect() : null;
        const leftLimit = rootRect ? rootRect.right - 8 : br.left + 520;
        const optionNodes = Array.from(searchRoot.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],div,a,li'))
          .filter((el) => isVisible(el) && inViewport(el) && el !== modelBtn);

        const seen = new Set();
        const models = optionNodes
          .map((el) => {
            const rect = el.getBoundingClientRect();
            if (rootRect) {
              if (rect.top < rootRect.top + 8 || rect.bottom > rootRect.bottom - 4) return null;
              if (rect.left < rootRect.left - 4 || rect.right > leftLimit) return null;
            }
            if (rect.width < 90 || rect.width > 520 || rect.height < 14 || rect.height > 68) return null;

            const candidateTexts = [
              normalize(el.textContent || ''),
              ...Array.from(el.querySelectorAll('span,div')).map((node) => normalize(node.textContent || ''))
            ]
              .filter((text) => text.length >= 3 && text.length <= 80)
              .map(cleanModelLabel)
              .filter((text) => text.length >= 3);

            if (candidateTexts.length === 0) return null;
            const keywordHits = candidateTexts.filter((text) => modelKeywords.some((keyword) => text.toLowerCase().includes(keyword)));
            if (keywordHits.length === 0) return null;
            // Prefer longer descriptive labels (to keep prefixes like GPT-5.4 or Grok Code Fast 1)
            const label = keywordHits.sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
            const labelLower = label.toLowerCase();
            if (
              labelLower.includes('search all models') ||
              labelLower.includes('recently used') ||
              labelLower.includes('recommended') ||
              labelLower.includes('group by') ||
              labelLower === 'free' ||
              labelLower === 'new' ||
              /^\d+(\.\d+)?x$/.test(labelLower) ||
              labelLower === 'single' ||
              labelLower === 'arena'
            ) {
              return null;
            }
            if (seen.has(labelLower)) return null;
            seen.add(labelLower);
            return { label, top: rect.top, left: rect.left };
          })
          .filter((value) => value !== null)
          .sort((a, b) => a.top - b.top || a.left - b.left)
          .map((value) => value.label);

        // Fallback: if we captured too few models, collect any keyword-bearing labels within the picker bounds
        if (models.length < 4 && pickerRoot) {
          const extra = Array.from(pickerRoot.querySelectorAll('button,[role="option"],[role="menuitem"],li'))
            .filter((el) => isVisible(el) && inViewport(el))
            .map((el) => {
              const rect = el.getBoundingClientRect();
              if (rect.top < rootRect.top || rect.bottom > rootRect.bottom) return null;
              if (rect.left < rootRect.left - 6 || rect.right > rootRect.right + 6) return null;
              if (rect.width < 80 || rect.width > 520 || rect.height < 12 || rect.height > 72) return null;
              const texts = [normalize(el.textContent || ''), ...Array.from(el.querySelectorAll('span,div')).map((n) => normalize(n.textContent || ''))]
                .filter((t) => t.length >= 3 && t.length <= 120)
                .map(cleanModelLabel)
                .filter((t) => t.length >= 3 && modelKeywords.some((keyword) => t.toLowerCase().includes(keyword)));
              if (texts.length === 0) return null;
              const label = texts.sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
              const lower = label.toLowerCase();
              if (
                lower.includes('search all models') ||
                lower.includes('recently used') ||
                lower.includes('recommended') ||
                lower.includes('group by') ||
                lower === 'free' ||
                lower === 'new' ||
                /^\d+(\.\d+)?x$/.test(lower) ||
                lower === 'single' ||
                lower === 'arena'
              ) {
                return null;
              }
              return label;
            })
            .filter(Boolean);
          for (const label of extra) {
            const lower = label.toLowerCase();
            if (!models.map((m) => m.toLowerCase()).includes(lower)) {
              models.push(label);
            }
          }
        }

        // Final dedupe by cleaned base label (drop badge tokens again)
        const deduped = [];
        const seenBase = new Set();
        for (const label of models) {
          const base = cleanModelLabel(label).toLowerCase();
          if (!base || seenBase.has(base)) continue;
          seenBase.add(base);
          deduped.push(cleanModelLabel(label));
        }

        document.body.click();
        return deduped;
      })();
    `;
    return (await this.cdp.evaluateJson<string[]>(client, expression)) ?? [];
  }

  private async injectPromptText(client: ClientDomains, prompt: string): Promise<boolean> {
    const escapedPrompt = JSON.stringify(prompt);
    const expression = `
      (() => {
        const el = document.activeElement;
        if (!el) return false;
        const text = ${escapedPrompt};

        // Windsurf Cascade uses div[role="textbox"] (contenteditable-like via ProseMirror/similar)
        if (el.getAttribute && el.getAttribute('role') === 'textbox') {
          el.textContent = text;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
          return true;
        }

        if (el.getAttribute && el.getAttribute('contenteditable') === 'true') {
          el.textContent = text;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
          return true;
        }

        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
          el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
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
    const selectorLiteral = JSON.stringify(config.windsurfResponseSelector);
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

        // Fallback selectors for Cascade/Windsurf response containers
        const selectors = [
          '[class*="text-ide-message-block-bot-color"] [class*="prose"]',
          '[class*="markdown-renderer-root"]',
          '[class*="prose-sm"]',
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
