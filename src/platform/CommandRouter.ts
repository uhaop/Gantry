import { BridgeService } from "../bridge/BridgeService";
import { BridgeMode } from "../types";
import { ChatStateStore } from "../telegram/ChatStateStore";
import { TextSecurityGuard } from "../security/TextSecurityGuard";
import { config } from "../config";

interface ProgressState {
  requestId: number;
  phase: string;
  startedAt: number;
  updatedAt: number;
}

export class CommandRouter {
  private readonly bridge = new BridgeService();
  private readonly stateStore = new ChatStateStore();
  private readonly lastPromptByChannel = new Map<string, { prompt: string; at: number }>();
  private readonly activeRequestByChannel = new Map<string, number>();
  private readonly progressByChannel = new Map<string, ProgressState>();
  private nextRequestId = 1;

  async handle(channelId: string, text: string): Promise<string> {
    const value = text.trim();
    if (!value) {
      return "Empty message.";
    }

    if (value === "/help" || value === "/start") {
      return this.helpText();
    }
    if (value === "/models") {
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.listModels());
    }
    if (value.startsWith("/model")) {
      const modelArg = value.replace("/model", "").trim();
      if (!modelArg) {
        return TextSecurityGuard.sanitizeOutbound(await this.bridge.getModel());
      }
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.setModel(modelArg));
    }
    if (value.startsWith("/mode")) {
      const mode = value.replace("/mode", "").trim().toLowerCase() as BridgeMode;
      const validModes = config.bridgeIdeTarget === "windsurf" ? ["ask", "code", "plan"] : ["ask", "code", "plan", "debug"];
      if (!validModes.includes(mode)) {
        return `Invalid mode. Use: /mode ${validModes.join("|")}`;
      }
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.switchMode(mode));
    }
    if (value === "/newchat") {
      // Allow raw output so diagnostic fields (e.g., new chat candidates) are visible to the user
      return await this.bridge.newChat();
    }
    if (value === "/context") {
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.contextStatus());
    }
    if (value === "/usage") {
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.usageStatus());
    }
    if (value === "/restart") {
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.restart());
    }
    if (value === "/diag") {
      // Allow raw diagnostics output (no redaction) for troubleshooting
      return await this.bridge.diagnostics();
    }
    if (value === "/chats" || value === "/targets") {
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.listChats());
    }
    if (value.startsWith("/target")) {
      const arg = value.replace("/target", "").trim().toLowerCase();
      if (!arg) {
        return TextSecurityGuard.sanitizeOutbound(await this.bridge.targetStatus());
      }
      if (arg === "auto") {
        return TextSecurityGuard.sanitizeOutbound(await this.bridge.selectTarget("auto"));
      }
      const index = Number(arg);
      if (!Number.isInteger(index) || index <= 0) {
        return "Invalid target. Use /target <index> or /target auto.";
      }
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.selectTarget(index));
    }
    if (value === "/queue") {
      return "Attachment queue is only available in Telegram mode.";
    }
    if (value === "/clearqueue") {
      return "Attachment queue is only available in Telegram mode.";
    }
    if (value === "/progress") {
      return this.progressStatus(channelId);
    }
    if (value.startsWith("/cancel")) {
      const arg = value.replace("/cancel", "").trim().toLowerCase();
      if (arg === "all") {
        return this.cancelAll();
      }
      return this.cancel(channelId);
    }
    if (value === "/last") {
      const latest = await this.bridge.latestResponse();
      if (latest) {
        return TextSecurityGuard.sanitizeOutbound(latest);
      }
      const stored = this.stateStore.getLastDelivered(this.channelKeyToNumber(channelId));
      return TextSecurityGuard.sanitizeOutbound(stored?.text ?? "No response available yet.");
    }
    if (value.startsWith("/history")) {
      return this.history(channelId, value);
    }
    if (value.startsWith("/resume")) {
      const arg = value.replace("/resume", "").trim();
      if (arg) {
        return await this.relayPrompt(channelId, arg);
      }
      const previous = this.lastPromptByChannel.get(channelId)?.prompt
        ?? this.stateStore.getLastPrompt(this.channelKeyToNumber(channelId))?.prompt;
      if (!previous) {
        return "No previous prompt found.";
      }
      return await this.relayPrompt(channelId, `Continue the previous task.\nOriginal request: ${previous}`);
    }

    return TextSecurityGuard.sanitizeOutbound(await this.relayPrompt(channelId, value));
  }

  private async relayPrompt(channelId: string, prompt: string): Promise<string> {
    const policy = TextSecurityGuard.evaluatePrompt(prompt);
    if (!policy.allowed) {
      return policy.reason ?? "Blocked by safety policy.";
    }
    const requestId = this.nextRequestId++;
    const startedAt = Date.now();
    this.lastPromptByChannel.set(channelId, { prompt, at: startedAt });
    this.stateStore.recordPrompt(this.channelKeyToNumber(channelId), prompt, startedAt);
    this.activeRequestByChannel.set(channelId, requestId);
    this.progressByChannel.set(channelId, { requestId, phase: "running", startedAt, updatedAt: startedAt });
    try {
      const response = await this.bridge.relayPrompt(prompt);
      this.stateStore.recordDelivered(this.channelKeyToNumber(channelId), response, requestId, Date.now());
      this.progressByChannel.delete(channelId);
      this.activeRequestByChannel.delete(channelId);
      return TextSecurityGuard.sanitizeOutbound(response);
    } catch (error) {
      this.progressByChannel.delete(channelId);
      this.activeRequestByChannel.delete(channelId);
      throw error;
    }
  }

  private progressStatus(channelId: string): string {
    const progress = this.progressByChannel.get(channelId);
    if (!progress) {
      return "No active request in progress.";
    }
    const elapsed = Math.max(0, Math.round((Date.now() - progress.startedAt) / 1000));
    return `Request #${progress.requestId} is ${progress.phase}. Elapsed: ${elapsed}s.`;
  }

  private cancel(channelId: string): string {
    const requestId = this.activeRequestByChannel.get(channelId);
    if (!requestId) {
      return "No active request to cancel.";
    }
    this.activeRequestByChannel.delete(channelId);
    this.progressByChannel.delete(channelId);
    return `Cancelled active request #${requestId}.`;
  }

  private cancelAll(): string {
    const count = this.activeRequestByChannel.size;
    this.activeRequestByChannel.clear();
    this.progressByChannel.clear();
    return count > 0 ? `Cancelled ${count} active request(s).` : "No active requests to cancel.";
  }

  private history(channelId: string, text: string): string {
    const arg = text.replace("/history", "").trim().toLowerCase();
    const chatId = this.channelKeyToNumber(channelId);
    if (arg === "clear") {
      const removed = this.stateStore.clearHistory(chatId);
      return removed > 0 ? `Cleared ${removed} history entr${removed === 1 ? "y" : "ies"}.` : "History is already empty.";
    }
    let limit = Number(arg);
    if (!Number.isFinite(limit) || limit <= 0) {
      limit = 5;
    }
    limit = Math.min(limit, 10);
    const history = this.stateStore.getHistory(chatId, limit);
    if (history.length === 0) {
      return "No response history available yet.";
    }
    return TextSecurityGuard.sanitizeOutbound(
      history.map((item, idx) => `${idx + 1}. [${new Date(item.at).toISOString()}] ${item.text}`).join("\n")
    );
  }

  private channelKeyToNumber(channelId: string): number {
    let hash = 0;
    for (let i = 0; i < channelId.length; i += 1) {
      hash = (hash * 31 + channelId.charCodeAt(i)) >>> 0;
    }
    return hash;
  }

  private helpText(): string {
    return [
      "Bridge commands:",
      config.bridgeIdeTarget === "windsurf" ? "/mode ask|code|plan" : "/mode ask|code|plan|debug",
      "/model [model-name]",
      "/newchat",
      "/context",
      "/usage",
      "/progress",
      "/resume [optional instruction]",
      "/cancel [all]",
      "/last",
      "/history [optional count|clear]",
      "/chats",
      "/targets",
      "/target <index>|auto",
      "/diag"
    ].join("\n");
  }
}

