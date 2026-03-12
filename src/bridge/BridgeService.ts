import { CursorAutomationClient } from "../cursor/CursorAutomationClient";
import { CursorContextExtractor } from "../cursor/CursorContextExtractor";
import { CursorSqliteDiagnostics } from "../cursor/CursorSqliteDiagnostics";
import { spawn } from "child_process";
import path from "path";
import { WindsurfAutomationClient } from "../windsurf/WindsurfAutomationClient";
import { ImageInjectionService } from "../media/ImageInjectionService";
import { BridgeMode } from "../types";
import { config } from "../config";
import { CursorApiBackend } from "../backends/CursorApiBackend";
import { logger } from "../logger";
import { VscodeAutomationClient } from "../vscode/VscodeAutomationClient";

type IdeClient = CursorAutomationClient | WindsurfAutomationClient | VscodeAutomationClient;

export class BridgeService {
  private readonly apiBackend = new CursorApiBackend();
  private readonly ideClient: IdeClient;

  constructor(
    private readonly cursorClient = new CursorAutomationClient(),
    private readonly contextExtractor = new CursorContextExtractor(),
    private readonly sqliteDiagnostics = new CursorSqliteDiagnostics(),
    private readonly imageInjector = new ImageInjectionService(),
    private readonly vscodeClient = new VscodeAutomationClient()
  ) {
    if (config.bridgeIdeTarget === "windsurf") {
      this.ideClient = new WindsurfAutomationClient();
    } else if (config.bridgeIdeTarget === "vscode") {
      this.ideClient = this.vscodeClient;
    } else {
      this.ideClient = this.cursorClient;
    }
  }

  async restart(): Promise<string> {
    // Relaunch using platform-specific .bat launchers (Windows-only).
    const cwd = path.resolve(__dirname, "..", "..");
    const env = { ...process.env };
    if (!env.DOTENV_CONFIG_PATH) delete env.DOTENV_CONFIG_PATH;

    const script =
      config.bridgeIdeTarget === "windsurf"
        ? "run-windsurf.bat"
        : config.bridgeIdeTarget === "vscode"
          ? "run-vscode.bat"
          : "run-cursor.bat";
    const scriptPath = path.resolve(cwd, script);

    try {
      const child = spawn("cmd.exe", ["/c", scriptPath], {
        cwd,
        env,
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.unref();
    } catch (error) {
      logger.error({ error }, "Failed to spawn restart process via launcher", { scriptPath });
      return "Restart failed to launch.";
    }

    setTimeout(() => {
      process.exit(0);
    }, 500);

    return "Restarting bridge...";
  }

  async switchMode(mode: BridgeMode): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return (await this.apiBackend.switchMode(mode)).text;
    }
    const result = await this.ideClient.setMode(mode);
    return result.text;
  }

  async relayPrompt(prompt: string): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return (await this.apiBackend.relayPrompt(prompt)).text;
    }
    const result = await this.ideClient.sendPrompt(prompt);
    return result.text;
  }

  async relayPromptForPendingAttachment(
    prompt: string,
    kind: "photo" | "document",
    fileName?: string
  ): Promise<string> {
    const options: { preferAttachmentComposer?: boolean; attachmentKind?: "photo" | "document"; attachmentFileName?: string } = {
      preferAttachmentComposer: true,
      attachmentKind: kind
    };
    if (fileName) {
      options.attachmentFileName = fileName;
    }
    const result = await this.ideClient.sendPrompt(prompt, options);
    return result.text;
  }

  async latestResponse(): Promise<string | null> {
    if (config.bridgeBackendMode === "api") {
      return await this.apiBackend.latestResponse();
    }
    return await this.ideClient.latestAssistantSnippet();
  }

  async newChat(): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return (await this.apiBackend.newChat()).text;
    }
    const result = await this.ideClient.newChat();
    return result.text;
  }

  async getModel(): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "Model detection is unavailable in API backend mode.";
    }
    const result = await this.ideClient.getModel();
    return result.text;
  }

  async setModel(modelName: string): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "Model switching is unavailable in API backend mode.";
    }
    const result = await this.ideClient.setModel(modelName);
    return result.text;
  }

  async listModels(): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "Model listing is unavailable in API backend mode.";
    }
    if (config.bridgeIdeTarget === "windsurf" && this.ideClient instanceof WindsurfAutomationClient) {
      const result = await this.ideClient.listModels();
      return result.text;
    }
    if (config.bridgeIdeTarget === "vscode" && this.ideClient instanceof VscodeAutomationClient) {
      const result = await this.ideClient.listModels();
      return result.text;
    }
    return "Model listing is currently available for Windsurf and VS Code.";
  }

  async contextStatus(): Promise<string> {
    const context = await this.contextExtractor.readContextPercentage();

    const percentText = context.percent === null ? "unavailable" : `${context.percent}%`;
    return [
      "Context status",
      `• Context ${percentText}`
    ].join("\n");
  }

  async usageStatus(): Promise<string> {
    const context = await this.contextExtractor.readContextPercentage();

    const lines = [
      "Usage status",
      `• Context ${context.percent === null ? "unavailable" : `${context.percent}%`}`,
      `• Token usage: no stable public API; reporting best-effort UI-derived context only.`
    ];
    return lines.join("\n");
  }

  async listChats(): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "Target listing is unavailable in API backend mode.";
    }
    const ideName = config.bridgeIdeTarget === "windsurf" ? "Windsurf" : config.bridgeIdeTarget === "vscode" ? "VS Code" : "Cursor";
    const targets = await this.ideClient.listChatTargets();
    const selection = await this.ideClient.targetSelectionStatus();
    if (targets.length === 0) {
      return `No ${ideName} CDP targets found.`;
    }

    const lines = targets
      .filter((target) => target.type === "page")
      .slice(0, 10)
      .map((target, index) => {
        const pinned = selection.mode === "manual" && selection.manualTargetId === target.id ? " [PINNED]" : "";
        return `${index + 1}. ${target.title || "(untitled)"}${pinned} | ${target.url || "(no-url)"}`;
      });

    const header =
      selection.mode === "manual"
        ? `${ideName} targets (selection: manual -> ${selection.manualTargetTitle ?? "unknown"})`
        : `${ideName} targets (selection: auto)`;
    return `${header}\n${lines.join("\n")}`;
  }

  async selectTarget(selection: "auto" | number): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "Target selection is unavailable in API backend mode.";
    }
    const result = await this.ideClient.selectTarget(selection);
    return result.text;
  }

  async targetStatus(): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "Target selection is unavailable in API backend mode.";
    }
    const selection = await this.ideClient.targetSelectionStatus();
    if (selection.mode === "auto") {
      return "Target selection is auto.";
    }
    return `Target selection is manual: ${selection.manualTargetTitle ?? "(unknown title)"} (${selection.manualTargetId ?? "unknown id"}).`;
  }

  async diagnostics(): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return await this.apiBackend.diagnostics();
    }

    const ideName = config.bridgeIdeTarget === "windsurf" ? "Windsurf" : config.bridgeIdeTarget === "vscode" ? "VS Code" : "Cursor";
    const diag = await this.ideClient.diagnostics();

    const sel: {
      newChatCandidates?: number;
      newChatBestLabel?: string;
      fallbackTextboxCandidates?: number;
      fallbackResponseCandidates?: number;
    } =
      (diag && typeof diag === "object" && "selectorHealth" in diag && typeof diag.selectorHealth === "object"
        ? (diag.selectorHealth as {
            newChatCandidates?: number;
            newChatBestLabel?: string;
            fallbackTextboxCandidates?: number;
            fallbackResponseCandidates?: number;
          })
        : {}) || {};

    const lines = [
      `Bridge diagnostics (${ideName})`,
      `- ideTarget: ${config.bridgeIdeTarget}`,
      `- cdpReachable: ${diag.cdpReachable}`,
      `- versionEndpointReachable: ${diag.versionEndpointReachable}`,
      `- targets: total=${diag.targetCount}, pages=${diag.pageTargetCount}`,
      `- selectedTargetTitle: ${diag.selectedTargetTitle ?? "none"}`,
      `- chatInputFocusable: ${diag.chatInputFocusable === null ? "n/a" : diag.chatInputFocusable}`,
      `- detectedMode: ${diag.detectedMode ?? "unknown"}`,
      `- selectorHealth.chatInputMatches: ${diag.selectorHealth.configuredChatInputMatches}`,
      `- selectorHealth.responseMatches: ${diag.selectorHealth.configuredResponseMatches}`,
      `- selectorHealth.fallbackTextboxCandidates: ${sel.fallbackTextboxCandidates ?? "n/a"}`,
      `- selectorHealth.fallbackResponseCandidates: ${sel.fallbackResponseCandidates ?? "n/a"}`,
      `- selectorHealth.newChatCandidates: ${sel.newChatCandidates ?? "n/a"}`,
      `- selectorHealth.newChatBestLabel: ${sel.newChatBestLabel ?? "none"}`
    ];

    // Cursor-specific extras
    if (config.bridgeIdeTarget === "cursor") {
      const context = await this.contextExtractor.readContextPercentage();
      const sqlite = await this.sqliteDiagnostics.probe();
      const percentText = context.percent === null ? "unavailable" : `${context.percent}%`;
      const contextLine = `- context: **${percentText}** (source=${context.source}, confidence=${context.confidence})`;

      lines.push(contextLine, `- sqlite: ${sqlite}`);
    }

    return lines.join("\n");
  }

  async injectPhoto(
    filePath: string,
    options?: { autoSubmit?: boolean; fileName?: string; mimeType?: string; prompt?: string }
  ): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "Image injection is unavailable in API backend mode.";
    }
    const result = await this.imageInjector.injectPhotoFromTelegramFile(filePath, options);
    return result.text;
  }

  async injectDocument(
    filePath: string,
    options?: { autoSubmit?: boolean; fileName?: string; mimeType?: string; prompt?: string }
  ): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "Document injection is unavailable in API backend mode.";
    }
    const result = await this.imageInjector.injectDocumentFromTelegramFile(filePath, options);
    return result.text;
  }
}
