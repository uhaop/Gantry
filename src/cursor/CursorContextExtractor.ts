import { ContextReading } from "../types";
import { logger } from "../logger";
import { config } from "../config";
import { BaseCdpClient, ClientDomains } from "../cdp/BaseCdpClient";
import { CursorCdpClient } from "./CursorCdpClient";
import { WindsurfCdpClient } from "../windsurf/WindsurfCdpClient";
import { VscodeCdpClient } from "../vscode/VscodeCdpClient";
import sharp from "sharp";
import { recognize } from "tesseract.js";

function createCdpClientForContext(): BaseCdpClient {
  if (config.bridgeIdeTarget === "windsurf") return new WindsurfCdpClient();
  if (config.bridgeIdeTarget === "vscode") return new VscodeCdpClient();
  return new CursorCdpClient();
}

function contextSelectorForIde(): string {
  if (config.bridgeIdeTarget === "windsurf") return config.windsurfContextSelector;
  if (config.bridgeIdeTarget === "vscode") return config.vscodeContextSelector;
  return config.cursorContextSelector;
}

/**
 * Context extraction policy selected by user:
 * best-effort mixed method (DOM first, hover/OCR fallback, else unavailable).
 * IDE-aware: works for Cursor, Windsurf, and VS Code.
 */
export class CursorContextExtractor {
  private readonly cdp = createCdpClientForContext();

  async readContextPercentage(): Promise<ContextReading> {
    const domResult = await this.readFromDom();
    if (domResult) {
      return domResult;
    }

    const ocrResult = await this.readFromOcr();
    if (ocrResult) {
      return ocrResult;
    }

    logger.debug("DOM and OCR context reads unavailable");
    return {
      percent: null,
      confidence: 0,
      source: "unavailable",
      note: "Context gauge not readable with current adapter setup."
    };
  }

  private async readFromDom(): Promise<ContextReading | null> {
    try {
      return await this.cdp.withClient(async (client) => {
        return await this.extractDomPercent(client);
      });
    } catch (error) {
      logger.debug({ error }, "DOM context extraction failed");
      return null;
    }
  }

  private async readFromOcr(): Promise<ContextReading | null> {
    try {
      return await this.cdp.withClient(async (client) => {
        const configuredRegion = parseRegion(config.cursorContextRegion);
        const configuredHover = parsePoint(config.cursorContextHoverPoint);
        const autoHoverPoints = configuredHover ? [] : await this.deriveHoverProbePoints(client);
        const hoverPoints = configuredHover ? [configuredHover] : autoHoverPoints;

        const captureAndRead = async (
          screenshot: Buffer,
          cropRegion: { left: number; top: number; width: number; height: number } | null
        ): Promise<number | null> => {
          const cropped = cropRegion ? await sharp(screenshot).extract(cropRegion).png().toBuffer() : screenshot;
          const ocr = await recognize(cropped, "eng");
          return extractPercent(ocr.data.text);
        };

        for (const hover of hoverPoints) {
          await this.cdp.hoverPoint(client, hover.x, hover.y);
          const screenshot = await this.cdp.capturePng(client);
          const autoRegion = configuredRegion ?? (await this.buildProbeRegion(screenshot, hover));
          const matched = await captureAndRead(screenshot, autoRegion);
          if (matched !== null) {
            return {
              percent: matched,
              confidence: configuredHover ? 0.7 : 0.64,
              source: "hover-ocr",
              note: configuredHover
                ? "OCR extracted from configured hover point."
                : "OCR extracted from auto hover probe near composer."
            };
          }
        }

        const screenshot = await this.cdp.capturePng(client);
        const matched = await captureAndRead(screenshot, configuredRegion);
        if (matched === null) return null;

        return {
          percent: matched,
          confidence: configuredRegion ? 0.55 : 0.35,
          source: "hover-ocr",
          note: configuredRegion
            ? "OCR extracted from configured context region."
            : "OCR extracted from full screenshot without configured region."
        };
      });
    } catch (error) {
      logger.debug({ error }, "OCR context extraction failed");
      return null;
    }
  }

  private async extractDomPercent(client: ClientDomains): Promise<ContextReading | null> {
    const selectorLiteral = JSON.stringify(contextSelectorForIde());
    const result = await this.cdp.evaluateJson<{ percent: number | null; note?: string; confidence?: number }>(
      client,
      `
        (() => {
          function normalize(value) {
            return String(value || '').replace(/\\s+/g, ' ').trim();
          }

          function lower(value) {
            return normalize(value).toLowerCase();
          }

          function isVisible(el) {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none';
          }

          function extractPercents(text) {
            const matches = String(text || '').match(/\\b(\\d{1,3})\\s*%\\b/g) || [];
            const values = [];
            for (const raw of matches) {
              const parsed = Number(String(raw).replace('%', '').trim());
              if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) {
                values.push(parsed);
              }
            }
            return Array.from(new Set(values));
          }

          function findComposerRoot() {
            const inputs = [
              ...Array.from(document.querySelectorAll('textarea')),
              ...Array.from(document.querySelectorAll('[contenteditable="true"]')),
              ...Array.from(document.querySelectorAll('[role="textbox"]'))
            ].filter(isVisible);

            if (inputs.length === 0) return null;

            inputs.sort((a, b) => {
              const ar = a.getBoundingClientRect();
              const br = b.getBoundingClientRect();
              return (br.width * br.height + br.top) - (ar.width * ar.height + ar.top);
            });
            const input = inputs[0];
            return (
              input.closest('[class*="composer"]') ||
              input.closest('[class*="ai-input"]') ||
              input.closest('[class*="input-box"]') ||
              input.parentElement
            );
          }

          function scoreCandidate({ text, percent, tier, distance }) {
            const txt = lower(text);
            let score = tier === 'composer-scan' ? 55 : 35;
            if (txt.includes('context window')) score += 22;
            if (txt.includes('context')) score += 16;
            if (txt.includes('token')) score += 14;
            if (txt.includes('usage')) score += 8;
            if (txt.includes('used')) score += 6;
            if (txt.includes('remaining')) score += 6;
            if (txt.includes('auto')) score -= 4;
            if (txt.includes('agent')) score -= 3;
            if (distance !== null) {
              score += Math.max(0, 14 - Math.floor(distance / 24));
            }
            if (percent === 0 && !(txt.includes('context') || txt.includes('token'))) {
              score -= 30;
            }
            return score;
          }

          function collectCandidates(elements, tier, originRect) {
            const blockedTags = new Set(['html', 'body', 'head', 'style', 'script', 'noscript', 'svg', 'path', 'defs']);
            const candidates = [];
            for (const el of elements) {
              if (!isVisible(el)) continue;
              const tag = String(el.tagName || '').toLowerCase();
              if (blockedTags.has(tag)) continue;
              const text = normalize((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || ''));
              if (!text || !text.includes('%')) continue;
              if (text.length > 220) continue;
              const cssSignal = (text.match(/[{};:]/g) || []).length;
              if (cssSignal >= 8) continue;

              const values = extractPercents(text);
              if (values.length === 0) continue;
              const rect = el.getBoundingClientRect();
              const distance = originRect
                ? Math.hypot(Math.max(0, rect.left - originRect.right, originRect.left - rect.right), Math.max(0, rect.top - originRect.bottom, originRect.top - rect.bottom))
                : null;
              for (const percent of values) {
                candidates.push({
                  percent,
                  note: tier,
                  score: scoreCandidate({ text, percent, tier, distance }),
                  text
                });
              }
            }
            return candidates;
          }

          const configured = ${selectorLiteral};
          if (configured) {
            const explicit = document.querySelector(configured);
            if (explicit) {
              const ariaVal = Number(explicit.getAttribute('aria-valuenow'));
              if (Number.isFinite(ariaVal) && ariaVal >= 0 && ariaVal <= 100) {
                return { percent: Math.round(ariaVal), note: 'configured-selector-aria', confidence: 0.96 };
              }
              const value = extractPercents((explicit.textContent || '') + ' ' + (explicit.getAttribute('aria-label') || '') + ' ' + (explicit.getAttribute('title') || ''))[0];
              if (value !== undefined) {
                return { percent: value, note: 'configured-selector', confidence: 0.94 };
              }
            }
          }

          // Strategy: progressbar role with aria-valuenow (most reliable)
          const progressBars = Array.from(document.querySelectorAll('[role="progressbar"]')).filter(isVisible);
          for (const pb of progressBars) {
            const ariaVal = Number(pb.getAttribute('aria-valuenow'));
            const ariaMax = Number(pb.getAttribute('aria-valuemax') || '100');
            const label = lower((pb.getAttribute('aria-label') || '') + ' ' + (pb.closest('[class*="context"],[class*="token"],[class*="usage"]')?.className || ''));
            const isContextRelated = label.includes('context') || label.includes('token') || label.includes('usage');
            if (Number.isFinite(ariaVal) && ariaVal >= 0 && ariaMax > 0) {
              const pct = Math.round((ariaVal / ariaMax) * 100);
              if (pct >= 0 && pct <= 100) {
                return { percent: pct, note: isContextRelated ? 'progressbar-aria-context' : 'progressbar-aria', confidence: isContextRelated ? 0.92 : 0.75 };
              }
            }
          }

          // Strategy: HTML <progress> elements
          const progressEls = Array.from(document.querySelectorAll('progress')).filter(isVisible);
          for (const pe of progressEls) {
            const val = pe.value;
            const max = pe.max || 100;
            if (Number.isFinite(val) && val >= 0 && max > 0) {
              const pct = Math.round((val / max) * 100);
              if (pct >= 0 && pct <= 100) {
                return { percent: pct, note: 'progress-element', confidence: 0.80 };
              }
            }
          }

          // Strategy: SVG circular progress (stroke-dashoffset / stroke-dasharray ratio)
          const svgCircles = Array.from(document.querySelectorAll('svg circle, svg path'));
          for (const shape of svgCircles) {
            const cs = window.getComputedStyle(shape);
            const dashArray = parseFloat(cs.strokeDasharray);
            const dashOffset = parseFloat(cs.strokeDashoffset);
            if (Number.isFinite(dashArray) && dashArray > 0 && Number.isFinite(dashOffset)) {
              const ratio = 1 - (dashOffset / dashArray);
              const pct = Math.round(Math.max(0, Math.min(100, ratio * 100)));
              if (pct <= 0 || pct > 100) continue;

              const svgEl = shape.closest('svg');
              // Walk up ancestors (up to 12 levels) collecting class names for hint matching
              const ancestorClasses = [];
              let walker = svgEl;
              for (let depth = 0; depth < 12 && walker; depth++) {
                walker = walker.parentElement;
                if (walker) ancestorClasses.push(lower(String(walker.className || '')));
              }
              const ancestorChain = ancestorClasses.join(' ');

              // Check for explicit context/token/usage hints in ancestor chain
              const hasContextHint =
                ancestorChain.includes('context') || ancestorChain.includes('token') || ancestorChain.includes('usage');
              if (hasContextHint) {
                return { percent: pct, note: 'svg-stroke-context', confidence: 0.90 };
              }

              // Cursor: composer/ai-input class patterns
              const nearComposer = svgEl?.closest('[class*="composer"],[class*="chat"],[class*="ai-input"],[class*="input-box"]');
              if (nearComposer) {
                return { percent: pct, note: 'svg-stroke-composer', confidence: 0.85 };
              }
              if (ancestorChain.includes('composer') || ancestorChain.includes('ai-input')) {
                return { percent: pct, note: 'svg-stroke-composer-ancestor', confidence: 0.82 };
              }

              // Windsurf: Tailwind utility classes — match on IDE-specific panel/chat patterns
              const nearWindsurfPanel = svgEl?.closest('[class*="text-ide-"],[class*="panel-bg"],[class*="panel-border"]');
              if (nearWindsurfPanel) {
                return { percent: pct, note: 'svg-stroke-windsurf-panel', confidence: 0.85 };
              }
              if (ancestorChain.includes('text-ide-') || ancestorChain.includes('panel-bg') || ancestorChain.includes('shadow-menu')) {
                return { percent: pct, note: 'svg-stroke-windsurf-ancestor', confidence: 0.82 };
              }

              // Fallback: if exactly 1 SVG gauge exists on the page, it's almost certainly the context indicator
              const allSvgGauges = Array.from(document.querySelectorAll('svg circle, svg path')).filter(s => {
                const scs = window.getComputedStyle(s);
                const sda = parseFloat(scs.strokeDasharray);
                const sdo = parseFloat(scs.strokeDashoffset);
                return sda > 0 && Number.isFinite(sdo);
              });
              if (allSvgGauges.length === 1) {
                return { percent: pct, note: 'svg-stroke-sole-gauge', confidence: 0.75 };
              }
            }
          }

          // Strategy: CSS width-based progress bars (computed width, not just inline style)
          const composerRoot = findComposerRoot();
          const barSelectors = '[class*="progress"],[class*="bar"],[class*="fill"],[class*="gauge"],[class*="indicator"],[class*="track"],[class*="meter"]';

          // Search globally for context-related CSS bars
          const globalBarCandidates = Array.from(document.querySelectorAll(barSelectors)).filter(isVisible);
          for (const bar of globalBarCandidates) {
            // Check inline style width
            const inlineStyle = bar.getAttribute('style') || '';
            const inlineMatch = inlineStyle.match(/width:\\s*(\\d{1,3})(\\.\\d+)?\\s*%/);
            // Check computed width vs parent width (for non-inline percentage widths)
            const barRect = bar.getBoundingClientRect();
            const parentRect = bar.parentElement?.getBoundingClientRect();
            const computedPct = parentRect && parentRect.width > 10
              ? Math.round((barRect.width / parentRect.width) * 100)
              : null;

            const parentChain = lower(
              (bar.className || '') + ' ' +
              (bar.parentElement?.className || '') + ' ' +
              (bar.parentElement?.parentElement?.className || '') + ' ' +
              (bar.closest('[class*="context"],[class*="token"],[class*="usage"]')?.className || '')
            );
            const isContextBar =
              parentChain.includes('context') || parentChain.includes('token') || parentChain.includes('usage');

            if (inlineMatch) {
              const pct = Math.round(Number(inlineMatch[1]));
              if (pct >= 0 && pct <= 100) {
                return { percent: pct, note: isContextBar ? 'css-width-context' : 'css-width-bar', confidence: isContextBar ? 0.88 : 0.78 };
              }
            }
            if (computedPct !== null && computedPct >= 1 && computedPct <= 100 && isContextBar) {
              return { percent: computedPct, note: 'computed-width-context', confidence: 0.84 };
            }
          }

          // Strategy: conic-gradient on any element (circular CSS gauge)
          const allVisibleEls = Array.from(document.querySelectorAll('*')).filter(isVisible);
          for (const el of allVisibleEls) {
            const bg = window.getComputedStyle(el).backgroundImage || '';
            if (!bg.includes('conic-gradient')) continue;
            // Extract percentage from conic-gradient, e.g. "conic-gradient(#color 72%, ...)"
            const conicMatch = bg.match(/(\\d{1,3})(\\.\\d+)?\\s*%/);
            if (conicMatch) {
              const pct = Math.round(Number(conicMatch[1]));
              const elText = lower((el.className || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.parentElement?.className || ''));
              const isContext = elText.includes('context') || elText.includes('token') || elText.includes('usage');
              if (pct >= 1 && pct <= 100 && isContext) {
                return { percent: pct, note: 'conic-gradient-context', confidence: 0.86 };
              }
              if (pct >= 1 && pct <= 100 && el.closest('[class*="composer"],[class*="chat"]')) {
                return { percent: pct, note: 'conic-gradient-composer', confidence: 0.74 };
              }
            }
          }

          // Strategy: transform rotate-based gauges (needle/arc indicators)
          const rotateEls = Array.from(document.querySelectorAll('[style*="rotate"],[class*="needle"],[class*="gauge"]')).filter(isVisible);
          for (const el of rotateEls) {
            const style = window.getComputedStyle(el).transform;
            if (!style || style === 'none') continue;
            // Parse rotate from matrix or rotate() — matrix(a,b,...) where angle = atan2(b,a)
            const matrixMatch = style.match(/matrix\\(([^)]+)\\)/);
            if (matrixMatch) {
              const parts = matrixMatch[1].split(',').map(Number);
              if (parts.length >= 2) {
                const angle = Math.atan2(parts[1], parts[0]) * (180 / Math.PI);
                const normalized = ((angle % 360) + 360) % 360;
                // Assume 0-180° or 0-270° range maps to 0-100%
                const pct = Math.round(Math.min(100, (normalized / 270) * 100));
                const nearContext = lower((el.parentElement?.className || '') + ' ' + (el.parentElement?.parentElement?.className || ''));
                if (pct >= 1 && pct <= 100 && (nearContext.includes('context') || nearContext.includes('token'))) {
                  return { percent: pct, note: 'css-rotate-gauge', confidence: 0.70 };
                }
              }
            }
          }

          // Strategy: text-based scan within composer
          if (composerRoot) {
            const composerElements = [
              composerRoot,
              ...Array.from(composerRoot.querySelectorAll('*'))
            ];
            const composerCandidates = collectCandidates(composerElements, 'composer-scan', composerRoot.getBoundingClientRect())
              .sort((a, b) => b.score - a.score);
            const bestComposer = composerCandidates[0];
            if (bestComposer && bestComposer.score >= 50) {
              return { percent: bestComposer.percent, note: 'composer-scan', confidence: 0.86 };
            }
          }

          // Strategy: tooltip/title attributes on any visible element
          const tooltipEls = Array.from(document.querySelectorAll('[title],[aria-label]')).filter(isVisible);
          for (const el of tooltipEls) {
            const title = normalize(el.getAttribute('title') || '');
            const ariaLabel = normalize(el.getAttribute('aria-label') || '');
            const combined = lower(title + ' ' + ariaLabel);
            if ((combined.includes('context') || combined.includes('token')) && combined.includes('%')) {
              const vals = extractPercents(title + ' ' + ariaLabel);
              if (vals.length > 0) {
                return { percent: vals[0], note: 'tooltip-context', confidence: 0.88 };
              }
            }
          }

          // Strategy: global text scan (lowest priority)
          const globalElements = Array.from(document.querySelectorAll('*'));
          const globalCandidates = collectCandidates(globalElements, 'global-ranked', null)
            .filter((candidate) => {
              const txt = lower(candidate.text);
              return txt.includes('context') || txt.includes('token') || txt.includes('window');
            })
            .sort((a, b) => b.score - a.score);
          const bestGlobal = globalCandidates[0];
          if (bestGlobal && bestGlobal.score >= 42) {
            return { percent: bestGlobal.percent, note: 'global-ranked', confidence: 0.72 };
          }

          if (bestGlobal && bestGlobal.percent === 0) {
            return { percent: null, note: 'rejected-low-signal', confidence: 0.2 };
          }

          return { percent: null };
        })();
      `
    );

    if (!result || result.percent === null) {
      if (result?.note === "rejected-low-signal") {
        logger.debug({ result }, "Rejected low-signal DOM context candidate");
      }
      return null;
    }

    const note = result.note ?? "global-ranked";
    return {
      percent: result.percent,
      confidence:
        result.confidence ??
        (note === "configured-selector" ? 0.94 : note === "composer-scan" ? 0.86 : 0.72),
      source: "dom",
      note
    };
  }

  private async deriveHoverProbePoints(client: ClientDomains): Promise<Array<{ x: number; y: number }>> {
    const points = await this.cdp.evaluateJson<Array<{ x: number; y: number }>>(
      client,
      `
        (() => {
          function normalize(value) {
            return String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
          }
          function isVisible(el) {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none';
          }

          const nodes = Array.from(
            document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],[class*="composer"],[class*="auto"]')
          ).filter(isVisible);
          const scored = [];
          for (const node of nodes) {
            const text = normalize(
              (node.textContent || '') + ' ' + (node.getAttribute('aria-label') || '') + ' ' + (node.getAttribute('title') || '')
            );
            const className = normalize(node.className || '');
            let score = 0;
            if (text.includes('context')) score += 10;
            if (text.includes('token')) score += 9;
            if (text.includes('auto')) score += 8;
            if (text.includes('agent')) score += 4;
            if (className.includes('composer')) score += 5;
            if (className.includes('auto')) score += 5;
            if (score < 8) continue;
            const rect = node.getBoundingClientRect();
            scored.push({
              score,
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2)
            });
          }

          scored.sort((a, b) => b.score - a.score);
          return scored.slice(0, 4).map((item) => ({ x: item.x, y: item.y }));
        })();
      `
    );
    return Array.isArray(points) ? points : [];
  }

  private async buildProbeRegion(
    screenshot: Buffer,
    hover: { x: number; y: number }
  ): Promise<{ left: number; top: number; width: number; height: number } | null> {
    const meta = await sharp(screenshot).metadata();
    const imgWidth = meta.width ?? 0;
    const imgHeight = meta.height ?? 0;
    if (imgWidth <= 0 || imgHeight <= 0) {
      return null;
    }

    const width = 520;
    const height = 220;
    const left = Math.max(0, Math.min(imgWidth - width, hover.x - Math.round(width / 2)));
    const top = Math.max(0, Math.min(imgHeight - height, hover.y - Math.round(height / 2)));

    if (width <= 0 || height <= 0) {
      return null;
    }

    return { left, top, width, height };
  }
}

function parseRegion(raw: string): { left: number; top: number; width: number; height: number } | null {
  if (!raw.trim()) {
    return null;
  }

  const parts = raw.split(",").map((item) => Number(item.trim()));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value) || value < 0)) {
    return null;
  }

  return {
    left: parts[0] as number,
    top: parts[1] as number,
    width: parts[2] as number,
    height: parts[3] as number
  };
}

function parsePoint(raw: string): { x: number; y: number } | null {
  if (!raw.trim()) {
    return null;
  }

  const parts = raw.split(",").map((item) => Number(item.trim()));
  if (parts.length !== 2 || parts.some((value) => !Number.isFinite(value) || value < 0)) {
    return null;
  }

  return { x: parts[0] as number, y: parts[1] as number };
}

function extractPercent(text: string): number | null {
  const match = text.match(/\b(\d{1,3})\s*%\b/);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    return null;
  }
  return parsed;
}
