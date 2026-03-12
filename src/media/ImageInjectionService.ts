import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { lookup as lookupMime } from "mime-types";
import { BridgeResponse } from "../types";
import { logger } from "../logger";
import { config } from "../config";
import { BaseCdpClient } from "../cdp/BaseCdpClient";
import { CursorCdpClient } from "../cursor/CursorCdpClient";
import { WindsurfCdpClient } from "../windsurf/WindsurfCdpClient";
import { VscodeCdpClient } from "../vscode/VscodeCdpClient";

const execAsync = promisify(exec);

function createCdpClientForInjection(): BaseCdpClient {
  if (config.bridgeIdeTarget === "windsurf") return new WindsurfCdpClient();
  if (config.bridgeIdeTarget === "vscode") return new VscodeCdpClient();
  return new CursorCdpClient();
}

function chatInputSelectorForIde(): string {
  if (config.bridgeIdeTarget === "windsurf") return config.windsurfChatInputSelector;
  if (config.bridgeIdeTarget === "vscode") return config.vscodeChatInputSelector;
  return config.cursorChatInputSelector;
}

function ideDisplayName(): string {
  if (config.bridgeIdeTarget === "windsurf") return "Windsurf";
  if (config.bridgeIdeTarget === "vscode") return "VS Code";
  return "Cursor";
}

export class ImageInjectionService {
  private readonly cdp = createCdpClientForInjection();

  async injectPhotoFromTelegramFile(
    filePath: string,
    options?: { autoSubmit?: boolean; fileName?: string; mimeType?: string; prompt?: string }
  ): Promise<BridgeResponse> {
    return await this.injectFromTelegramFile(filePath, { ...options, kind: "photo" });
  }

  async injectDocumentFromTelegramFile(
    filePath: string,
    options?: { autoSubmit?: boolean; fileName?: string; mimeType?: string; prompt?: string }
  ): Promise<BridgeResponse> {
    return await this.injectFromTelegramFile(filePath, { ...options, kind: "document" });
  }

  private async injectFromTelegramFile(
    filePath: string,
    options?: { autoSubmit?: boolean; fileName?: string; mimeType?: string; prompt?: string; kind?: "photo" | "document" }
  ): Promise<BridgeResponse> {
    const autoSubmit = options?.autoSubmit !== false;
    const prompt = String(options?.prompt ?? "").trim();
    const shouldInjectPrompt = autoSubmit && prompt.length > 0;
    const shouldAttemptSubmit = autoSubmit;
    const kind = options?.kind ?? "photo";
    logger.info(
      { filePath, autoSubmit, promptProvided: prompt.length > 0, kind },
      kind === "photo" ? "Photo injection requested" : "Document injection requested"
    );

    const fileBuffer = await readFile(filePath);
    const fileName = options?.fileName?.trim() || basename(filePath);
    const mime = normalizeMime(filePath, options?.mimeType);
    const base64 = fileBuffer.toString("base64");

    try {
      // Keyboard-first path for attachment-only sends:
      // 1) set native clipboard payload, 2) Ctrl+V, 3) verify attachment in DOM.
      // This avoids synthetic-event-only behavior drift on Cursor surfaces.
      if (!shouldInjectPrompt) {
        const keyboardFirst = await this.tryKeyboardPrimaryAttachment(kind, filePath, fileName, shouldAttemptSubmit);
        if (keyboardFirst.ok) {
          logger.info(
            {
              kind,
              method: keyboardFirst.attachMethod,
              submitDispatched: keyboardFirst.submitDispatched,
              submitMethod: keyboardFirst.submitMethod
            },
            "Injection confirmed via keyboard-first path"
          );
          if (!autoSubmit) {
            return {
              text:
                kind === "photo"
                  ? `Image added in ${ideDisplayName()} composer. Type your prompt and send manually.`
                  : `Document added in ${ideDisplayName()} composer. Type your prompt and send manually.`,
              metadata: { status: "injected-manual", submit_method: "manual" }
            };
          }
          if (keyboardFirst.submitDispatched) {
            return {
              text: `${kind === "photo" ? "Image" : "Document"} injected and submit dispatched (${keyboardFirst.submitMethod ?? "unknown"}).`,
              metadata: { status: "injected-submitted", submit_method: keyboardFirst.submitMethod ?? "unknown" }
            };
          }
          return {
            text:
              kind === "photo"
                ? `Image added in ${ideDisplayName()} composer. Type your prompt and send manually.`
                : `Document added in ${ideDisplayName()} composer. Type your prompt and send manually.`,
            metadata: { status: "injected-manual", submit_method: keyboardFirst.submitMethod ?? "manual" }
          };
        }
      }

      const injected = await this.cdp.withClient(async (client) => {
        const selectorLiteral = JSON.stringify(chatInputSelectorForIde());
        const shouldInjectPromptLiteral = JSON.stringify(shouldInjectPrompt);
        const shouldAttemptSubmitLiteral = JSON.stringify(shouldAttemptSubmit);
        const promptLiteral = JSON.stringify(prompt);
        const fileNameLiteral = JSON.stringify(fileName.toLowerCase());
        const kindLiteral = JSON.stringify(kind);
        const expression = `
          (async () => {
            function isVisible(el) {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
            }

            const attachmentKind = ${kindLiteral};
            const configured = ${selectorLiteral};
            let inputEl = null;
            if (configured) {
              const explicit = document.querySelector(configured);
              if (explicit && isVisible(explicit)) inputEl = explicit;
            }

            if (!inputEl) {
              const candidates = [
                ...Array.from(document.querySelectorAll('textarea')),
                ...Array.from(document.querySelectorAll('[contenteditable="true"]')),
                ...Array.from(document.querySelectorAll('[role="textbox"]'))
              ].filter(isVisible);
              if (candidates.length > 0) inputEl = candidates[0];
            }

            if (!inputEl) return { ok: false, reason: 'chat-input-not-found' };
            inputEl.focus();

            const composerRoot =
              inputEl.closest('[class*="composer"],[class*="ai-input"],[class*="input-box"]') ||
              inputEl.parentElement;
            const rootIsFallback = !composerRoot;
            const countAttachmentSignals = () => {
              if (!composerRoot) return 0;
              const selectors = attachmentKind === 'photo'
                ? [
                    'img',
                    '[class*="image"]',
                    '[class*="attachment"]',
                    '[class*="upload"]',
                    '[data-testid*="image"]',
                    '[data-testid*="attachment"]',
                    '[aria-label*="attachment" i]',
                    '[aria-label*="uploaded" i]'
                  ]
                : [
                    '[class*="file"]',
                    '[class*="document"]',
                    '[class*="attachment"]',
                    '[class*="upload"]',
                    '[data-testid*="file"]',
                    '[data-testid*="attachment"]',
                    '[aria-label*="attachment" i]',
                    '[aria-label*="uploaded" i]'
                  ];
              let total = 0;
              for (const sel of selectors) {
                total += composerRoot.querySelectorAll(sel).length;
              }
              return total;
            };
            const countGlobalPhotoSignals = () => {
              if (attachmentKind !== 'photo') return 0;
              const selectors = [
                'img',
                '[class*="image"]',
                '[class*="attachment"]',
                '[class*="upload"]',
                '[data-testid*="image"]',
                '[data-testid*="attachment"]',
                '[aria-label*="attachment" i]',
                '[aria-label*="uploaded" i]'
              ];
              let total = 0;
              for (const sel of selectors) {
                total += document.querySelectorAll(sel).length;
              }
              return total;
            };
            const normalizedFileName = ${fileNameLiteral};
            const normalizedFileStem = normalizedFileName.replace(/\.[^\.]+$/, '');
            const hasFileNameProbe = attachmentKind === 'document' && normalizedFileName.length >= 4;
            const rootTextContainsFile = () => {
              if (!composerRoot) return false;
              if (!hasFileNameProbe) return false;
              const text = String(composerRoot.innerText || '').toLowerCase();
              if (!text) return false;
              if (text.includes(normalizedFileName)) return true;
              if (normalizedFileStem.length >= 4 && text.includes(normalizedFileStem)) return true;
              return false;
            };
            const tryClickSend = () => {
              const collect = (root) => {
                if (!root || !root.querySelectorAll) return [];
                return Array.from(
                  root.querySelectorAll(
                    'button,[role="button"],[data-testid*="send"],[aria-label*="send"],[title*="send"]'
                  )
                );
              };
              const normalize = (v) => String(v || '').toLowerCase();
              const scored = [...collect(composerRoot), ...collect(document.body)]
                .filter((el) => isVisible(el))
                .map((el) => {
                  const text = normalize([
                    el.textContent || '',
                    el.getAttribute('aria-label') || '',
                    el.getAttribute('title') || '',
                    el.getAttribute('data-testid') || '',
                    el.className || ''
                  ].join(' '));
                  const disabled =
                    el.getAttribute('aria-disabled') === 'true' ||
                    el.getAttribute('disabled') !== null ||
                    (typeof el.disabled === 'boolean' && el.disabled === true);
                  let score = 0;
                  if (text.includes('send')) score += 90;
                  if (text.includes('submit')) score += 40;
                  if (text.includes('composer')) score += 20;
                  if (disabled) score -= 150;
                  return { el, score, disabled };
                })
                .filter((entry) => entry.score > 0 && !entry.disabled)
                .sort((a, b) => b.score - a.score);
              const top = scored[0];
              if (!top) return false;
              top.el.click();
              return true;
            };
            const trySubmitByEnterOnInput = () => {
              if (!inputEl || typeof inputEl.dispatchEvent !== 'function') return false;
              inputEl.focus();
              const makeEvent = (type) =>
                new KeyboardEvent(type, {
                  key: 'Enter',
                  code: 'Enter',
                  keyCode: 13,
                  which: 13,
                  bubbles: true,
                  cancelable: true
                });
              inputEl.dispatchEvent(makeEvent('keydown'));
              inputEl.dispatchEvent(makeEvent('keypress'));
              inputEl.dispatchEvent(makeEvent('keyup'));
              return true;
            };
            const applyPromptText = (value) => {
              const text = String(value || '');
              if (!text) return false;
              if (inputEl instanceof HTMLTextAreaElement || inputEl instanceof HTMLInputElement) {
                inputEl.value = text;
                inputEl.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                inputEl.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
                return true;
              }
              if (inputEl.getAttribute && inputEl.getAttribute('contenteditable') === 'true') {
                inputEl.textContent = text;
                inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
                return true;
              }
              return false;
            };
            const okResult = (note) => {
              let promptInjected = false;
              if (${shouldInjectPromptLiteral}) {
                promptInjected = applyPromptText(${promptLiteral});
              }
              const submittedByButton = ${shouldAttemptSubmitLiteral} ? tryClickSend() : false;
              const submittedByInputEnter =
                ${shouldAttemptSubmitLiteral} && !submittedByButton ? trySubmitByEnterOnInput() : false;
              const submitDispatched = submittedByButton || submittedByInputEnter;
              return {
                ok: true,
                note,
                promptInjected,
                submitDispatched,
                submitMethod: submittedByButton
                  ? 'button'
                  : (submittedByInputEnter ? 'enter-dom' : (${shouldAttemptSubmitLiteral} ? 'none' : 'manual'))
              };
            };
            const beforeSignals = countAttachmentSignals();
            const beforeGlobalPhotoSignals = countGlobalPhotoSignals();
            const beforeFileNameSeen = rootTextContainsFile();

            const byteChars = atob(${JSON.stringify(base64)});
            const byteNumbers = new Array(byteChars.length);
            for (let i = 0; i < byteChars.length; i += 1) {
              byteNumbers[i] = byteChars.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const file = new File([byteArray], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mime)} });

            const transfer = new DataTransfer();
            transfer.items.add(file);
            const pasteEvent = new ClipboardEvent('paste', {
              clipboardData: transfer,
              bubbles: true,
              cancelable: true
            });

            const dispatched = inputEl.dispatchEvent(pasteEvent);

            await new Promise((resolve) => setTimeout(resolve, 350));
            const afterSignals = countAttachmentSignals();
            const afterGlobalPhotoSignals = countGlobalPhotoSignals();
            if (!rootIsFallback && afterSignals > beforeSignals) {
              return okResult(dispatched ? undefined : 'dispatch-returned-false-but-attachment-detected');
            }
            if (attachmentKind === 'photo' && afterGlobalPhotoSignals > beforeGlobalPhotoSignals) {
              return okResult(dispatched ? undefined : 'dispatch-returned-false-but-global-photo-detected');
            }
            const afterFileNameSeen = rootTextContainsFile();
            if (!beforeFileNameSeen && afterFileNameSeen) {
              return okResult(dispatched ? undefined : 'dispatch-returned-false-but-filename-detected');
            }

            // Some Electron surfaces accept file drop but ignore synthetic paste.
            const dropTarget = composerRoot || inputEl;
            try {
              const dragEnter = new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true });
              const dragOver = new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true });
              const dropEvent = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
              dropTarget.dispatchEvent(dragEnter);
              dropTarget.dispatchEvent(dragOver);
              dropTarget.dispatchEvent(dropEvent);
            } catch (_error) {
              // Ignore and continue to final detection.
            }

            await new Promise((resolve) => setTimeout(resolve, 600));
            const afterDropSignals = countAttachmentSignals();
            const afterDropGlobalPhotoSignals = countGlobalPhotoSignals();
            if (!rootIsFallback && afterDropSignals > beforeSignals) {
              return okResult('drop-fallback-attachment-detected');
            }
            if (attachmentKind === 'photo' && afterDropGlobalPhotoSignals > beforeGlobalPhotoSignals) {
              return okResult('drop-fallback-global-photo-detected');
            }
            const afterDropFileNameSeen = rootTextContainsFile();
            if (!beforeFileNameSeen && afterDropFileNameSeen) {
              return okResult('drop-fallback-filename-detected');
            }

            // Last resort: set an existing file input and dispatch change/input.
            try {
              const localInputs = composerRoot ? Array.from(composerRoot.querySelectorAll('input[type="file"]')) : [];
              const allInputs = Array.from(document.querySelectorAll('input[type="file"]'));
              const candidates = [...localInputs, ...allInputs];
              const imageInput = candidates.find((el) => {
                const accept = String(el.getAttribute('accept') || '').toLowerCase();
                if (!accept) return true;
                return (
                  accept.includes('image') ||
                  accept.includes('png') ||
                  accept.includes('jpg') ||
                  accept.includes('jpeg') ||
                  accept.includes('webp') ||
                  accept.includes('gif')
                );
              });

              if (imageInput) {
                imageInput.files = transfer.files;
                imageInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                imageInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

                await new Promise((resolve) => setTimeout(resolve, 700));
                const afterInputSignals = countAttachmentSignals();
                const afterInputGlobalPhotoSignals = countGlobalPhotoSignals();
                if (!rootIsFallback && afterInputSignals > beforeSignals) {
                  return okResult('file-input-fallback-attachment-detected');
                }
                if (attachmentKind === 'photo' && afterInputGlobalPhotoSignals > beforeGlobalPhotoSignals) {
                  return okResult('file-input-fallback-global-photo-detected');
                }
                const afterInputFileNameSeen = rootTextContainsFile();
                if (!beforeFileNameSeen && afterInputFileNameSeen) {
                  return okResult('file-input-fallback-filename-detected');
                }
              }
            } catch (_error) {
              // Ignore and continue to terminal failure reason.
            }

            if (!dispatched) {
              return { ok: false, reason: 'paste-event-dispatch-failed-no-attachment-detected' };
            }
            return { ok: false, reason: 'paste-drop-fileinput-no-attachment-detected' };
          })();
        `;

        const result = await this.cdp.evaluateJson<{
          ok: boolean;
          reason?: string;
          note?: string;
          promptInjected?: boolean;
          submitDispatched?: boolean;
          submitMethod?: string;
        }>(client, expression);
        if (result?.ok && !result.submitDispatched && shouldAttemptSubmit) {
          await this.cdp.evaluateJson<boolean>(
            client,
            `
              (() => {
                const isVisible = (el) => {
                  if (!el) return false;
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
                };
                const configured = ${JSON.stringify(chatInputSelectorForIde())};
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
                candidates[0].focus();
                return true;
              })();
            `
          );
          await this.cdp.sendShortcut(client, "Enter", "Enter", 13, 0);
          await new Promise((resolve) => setTimeout(resolve, 160));
          await this.cdp.sendShortcut(client, "Enter", "Enter", 13, 2);
          return { ...result, submitDispatched: true, submitMethod: "enter-key-seq" };
        }
        return result;
      });

      if (!injected?.ok) {
        const keyboardFallback = await this.tryKeyboardOnlyFallback(kind, filePath, fileName);
        if (keyboardFallback.ok) {
          logger.info({ kind, via: keyboardFallback.method }, "Injection recovered via keyboard-only fallback");
          return {
            text:
              kind === "photo"
                ? `Image added in ${ideDisplayName()} composer via keyboard fallback (Ctrl+V). Send prompt text next.`
                : `Document added in ${ideDisplayName()} composer via keyboard fallback (Ctrl+V). Send prompt text next.`,
            metadata: { status: "injected-manual", submit_method: keyboardFallback.method }
          };
        }
        logger.warn(
          { reason: injected?.reason ?? "unknown", note: injected?.note ?? null, kind },
          kind === "photo" ? "Photo injection not confirmed" : "Document injection not confirmed"
        );
        return {
          text:
            `${kind === "photo" ? "Image" : "Document"} injection failed (${injected?.reason ?? "unknown"}).\n` +
            "Fallback order attempted: synthetic paste -> synthetic drop -> file input -> keyboard paste (Ctrl+V).",
          metadata: { status: "failed" }
        };
      }

      logger.info(
        {
          note: injected.note ?? null,
          promptInjected: injected.promptInjected ?? null,
          submitDispatched: injected.submitDispatched ?? null,
          submitMethod: injected.submitMethod ?? null,
          kind
        },
        kind === "photo" ? "Photo injection confirmed" : "Document injection confirmed"
      );
      if (!autoSubmit) {
        return {
          text:
            kind === "photo"
              ? `Image added in ${ideDisplayName()} composer. Type your prompt and send manually.`
              : `Document added in ${ideDisplayName()} composer. Type your prompt and send manually.`,
          metadata: {
            status: "injected-manual",
            submit_method: "manual"
          }
        };
      }

      return {
        text: `${kind === "photo" ? "Image" : "Document"} injected and submit dispatched (${injected.submitMethod ?? "unknown"}).`,
        metadata: { status: "injected-submitted", submit_method: injected.submitMethod ?? "unknown" }
      };
    } catch (error) {
      logger.warn({ error, kind }, kind === "photo" ? "Photo injection failed through CDP" : "Document injection failed through CDP");
      return {
        text:
          kind === "photo"
            ? `Image injection failed through CDP. Manual paste in ${ideDisplayName()} may be required.`
            : `Document injection failed through CDP. Manual attach in ${ideDisplayName()} may be required.`,
        metadata: { status: "failed" }
      };
    }
  }

  private async tryNativeDocumentPaste(filePath: string, fileName: string): Promise<{ ok: boolean }> {
    try {
      if (process.platform !== "win32") {
        return { ok: false };
      }

      const escapedPath = filePath.replace(/'/g, "''");
      await execAsync(
        `powershell -NoProfile -Command "Set-Clipboard -Path '${escapedPath}'"`
      );

      const pasted = await this.cdp.withClient(async (client) => {
        const focused = await this.cdp.evaluateJson<boolean>(
          client,
          `
            (() => {
              const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
              };
              const configured = ${JSON.stringify(chatInputSelectorForIde())};
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
              candidates[0].focus();
              return document.activeElement === candidates[0];
            })();
          `
        );
        if (!focused) {
          return false;
        }

        // Ctrl+V (Windows) to paste native file payload.
        await this.cdp.sendShortcut(client, "v", "KeyV", 86, 2);
        await new Promise((resolve) => setTimeout(resolve, 900));

        const attached = await this.cdp.evaluateJson<boolean>(
          client,
          `
            (() => {
              const filename = ${JSON.stringify(fileName.toLowerCase())};
              const stem = filename.replace(/\\.[^\\.]+$/, '');
              const text = String(document.body?.innerText || '').toLowerCase();
              if (filename.length >= 4 && text.includes(filename)) return true;
              if (stem.length >= 4 && text.includes(stem)) return true;
              const selectors = [
                '[class*="file"]',
                '[class*="document"]',
                '[class*="attachment"]',
                '[class*="upload"]',
                '[data-testid*="file"]',
                '[data-testid*="attachment"]'
              ];
              for (const sel of selectors) {
                if (document.querySelector(sel)) return true;
              }
              return false;
            })();
          `
        );
        return attached === true;
      });

      return { ok: pasted === true };
    } catch (error) {
      logger.warn({ error }, "Native document paste fallback failed");
      return { ok: false };
    }
  }

  private async tryNativePhotoPaste(filePath: string): Promise<{ ok: boolean }> {
    try {
      if (process.platform !== "win32") {
        return { ok: false };
      }

      const escapedPath = filePath.replace(/'/g, "''");
      await execAsync(
        `powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $img=[System.Drawing.Image]::FromFile('${escapedPath}'); [System.Windows.Forms.Clipboard]::SetImage($img); $img.Dispose()"`
      );

      const pasted = await this.cdp.withClient(async (client) => {
        const baseline = await this.cdp.evaluateJson<{
          focused: boolean;
          beforeLocal: number;
          beforeGlobal: number;
        }>(
          client,
          `
            (() => {
              const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
              };
              const configured = ${JSON.stringify(chatInputSelectorForIde())};
              let inputEl = null;
              if (configured) {
                const explicit = document.querySelector(configured);
                if (explicit && isVisible(explicit)) inputEl = explicit;
              }
              if (!inputEl) {
                const candidates = [
                  ...Array.from(document.querySelectorAll('textarea')),
                  ...Array.from(document.querySelectorAll('[contenteditable="true"]')),
                  ...Array.from(document.querySelectorAll('[role="textbox"]'))
                ].filter(isVisible);
                if (candidates.length > 0) inputEl = candidates[0];
              }
              if (!inputEl) return { focused: false, beforeLocal: 0, beforeGlobal: 0 };
              inputEl.focus();
              const root =
                inputEl.closest('[class*="composer"],[class*="ai-input"],[class*="input-box"]') ||
                inputEl.parentElement;
              const selectors = [
                'img',
                '[class*="image"]',
                '[class*="attachment"]',
                '[class*="upload"]',
                '[data-testid*="image"]',
                '[data-testid*="attachment"]',
                '[aria-label*="attachment" i]',
                '[aria-label*="uploaded" i]'
              ];
              let beforeLocal = 0;
              if (root) {
                for (const sel of selectors) beforeLocal += root.querySelectorAll(sel).length;
              }
              let beforeGlobal = 0;
              for (const sel of selectors) beforeGlobal += document.querySelectorAll(sel).length;
              return { focused: true, beforeLocal, beforeGlobal };
            })();
          `
        );
        if (!baseline?.focused) {
          return false;
        }

        await this.cdp.sendShortcut(client, "v", "KeyV", 86, 2);
        await new Promise((resolve) => setTimeout(resolve, 900));

        const attachedAgainstBaseline = await this.cdp.evaluateJson<boolean>(
          client,
          `
            (() => {
              const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
              };
              const configured = ${JSON.stringify(chatInputSelectorForIde())};
              let inputEl = null;
              if (configured) {
                const explicit = document.querySelector(configured);
                if (explicit && isVisible(explicit)) inputEl = explicit;
              }
              if (!inputEl) {
                const candidates = [
                  ...Array.from(document.querySelectorAll('textarea')),
                  ...Array.from(document.querySelectorAll('[contenteditable="true"]')),
                  ...Array.from(document.querySelectorAll('[role="textbox"]'))
                ].filter(isVisible);
                if (candidates.length > 0) inputEl = candidates[0];
              }
              if (!inputEl) return false;
              const root =
                inputEl.closest('[class*="composer"],[class*="ai-input"],[class*="input-box"]') ||
                inputEl.parentElement;
              const selectors = [
                'img',
                '[class*="image"]',
                '[class*="attachment"]',
                '[class*="upload"]',
                '[data-testid*="image"]',
                '[data-testid*="attachment"]',
                '[aria-label*="attachment" i]',
                '[aria-label*="uploaded" i]'
              ];
              let afterLocal = 0;
              if (root) {
                for (const sel of selectors) afterLocal += root.querySelectorAll(sel).length;
              }
              let afterGlobal = 0;
              for (const sel of selectors) afterGlobal += document.querySelectorAll(sel).length;
              return afterLocal > ${baseline.beforeLocal} || afterGlobal > ${baseline.beforeGlobal};
            })();
          `
        );
        return attachedAgainstBaseline === true;
      });

      return { ok: pasted === true };
    } catch (error) {
      logger.warn({ error }, "Native photo paste fallback failed");
      return { ok: false };
    }
  }

  private async tryKeyboardPrimaryAttachment(
    kind: "photo" | "document",
    filePath: string,
    fileName: string,
    shouldAttemptSubmit: boolean
  ): Promise<{
    ok: boolean;
    attachMethod?: "keyboard-ctrl-v-native-image-clipboard" | "keyboard-ctrl-v-native-clipboard";
    submitDispatched?: boolean;
    submitMethod?: "enter-key-seq" | "manual";
  }> {
    try {
      const attached =
        kind === "photo" ? await this.tryNativePhotoPaste(filePath) : await this.tryNativeDocumentPaste(filePath, fileName);
      if (!attached.ok) {
        return { ok: false };
      }
      if (!shouldAttemptSubmit) {
        return {
          ok: true,
          attachMethod: kind === "photo" ? "keyboard-ctrl-v-native-image-clipboard" : "keyboard-ctrl-v-native-clipboard",
          submitDispatched: false,
          submitMethod: "manual"
        };
      }
      await this.cdp.withClient(async (client) => {
        await this.cdp.evaluateJson<boolean>(
          client,
          `
            (() => {
              const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
              };
              const configured = ${JSON.stringify(chatInputSelectorForIde())};
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
              candidates[0].focus();
              return true;
            })();
          `
        );
        await this.cdp.sendShortcut(client, "Enter", "Enter", 13, 0);
        await new Promise((resolve) => setTimeout(resolve, 160));
        await this.cdp.sendShortcut(client, "Enter", "Enter", 13, 2);
      });
      return {
        ok: true,
        attachMethod: kind === "photo" ? "keyboard-ctrl-v-native-image-clipboard" : "keyboard-ctrl-v-native-clipboard",
        submitDispatched: true,
        submitMethod: "enter-key-seq"
      };
    } catch (error) {
      logger.warn({ error, kind }, "Keyboard-first attachment path failed");
      return { ok: false };
    }
  }

  private async tryKeyboardOnlyFallback(
    kind: "photo" | "document",
    filePath: string,
    fileName: string
  ): Promise<{ ok: boolean; method: "keyboard-ctrl-v" | "keyboard-ctrl-v-native-clipboard" }> {
    if (kind === "document") {
      const native = await this.tryNativeDocumentPaste(filePath, fileName);
      if (native.ok) {
        return { ok: true, method: "keyboard-ctrl-v-native-clipboard" };
      }
    }

    try {
      const pasted = await this.cdp.withClient(async (client) => {
        const focused = await this.cdp.evaluateJson<boolean>(
          client,
          `
            (() => {
              const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
              };
              const configured = ${JSON.stringify(chatInputSelectorForIde())};
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
              candidates[0].focus();
              return document.activeElement === candidates[0];
            })();
          `
        );
        if (!focused) {
          return false;
        }
        await this.cdp.sendShortcut(client, "v", "KeyV", 86, 2);
        await new Promise((resolve) => setTimeout(resolve, 900));
        const attached = await this.cdp.evaluateJson<boolean>(
          client,
          `
            (() => {
              const kind = ${JSON.stringify(kind)};
              const filename = ${JSON.stringify(fileName.toLowerCase())};
              const stem = filename.replace(/\\.[^\\.]+$/, '');
              const text = String(document.body?.innerText || '').toLowerCase();
              if (filename.length >= 4 && text.includes(filename)) return true;
              if (stem.length >= 4 && text.includes(stem)) return true;
              const selectors = kind === 'photo'
                ? ['img','[class*="image"]','[class*="attachment"]','[class*="upload"]','[data-testid*="image"]','[data-testid*="attachment"]']
                : ['[class*="file"]','[class*="document"]','[class*="attachment"]','[class*="upload"]','[data-testid*="file"]','[data-testid*="attachment"]'];
              for (const sel of selectors) {
                if (document.querySelector(sel)) return true;
              }
              return false;
            })();
          `
        );
        return attached === true;
      });
      return { ok: pasted === true, method: "keyboard-ctrl-v" };
    } catch (error) {
      logger.warn({ error, kind }, "Keyboard-only fallback failed");
      return { ok: false, method: "keyboard-ctrl-v" };
    }
  }
}

function normalizeMime(filePath: string, fallback?: string): string {
  const fallbackValue = String(fallback || "").trim().toLowerCase();
  if (fallbackValue) {
    return fallbackValue;
  }

  const byLookup = lookupMime(filePath);
  if (typeof byLookup === "string" && byLookup.trim().length > 0) {
    return byLookup;
  }

  const ext = extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".png") return "image/png";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt") return "text/plain";
  if (ext === ".md") return "text/markdown";
  return "application/octet-stream";
}
