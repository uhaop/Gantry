import { Bot, GrammyError } from "grammy";
import type { Message, CallbackQuery, InlineKeyboardMarkup } from "grammy/types";
import { mkdirSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import { config } from "../config";
import { logger } from "../logger";
import { BridgeService } from "../bridge/BridgeService";
import { BridgeMode } from "../types";
import { ChatStateStore } from "./ChatStateStore";
import { TextSecurityGuard } from "../security/TextSecurityGuard";

export class TelegramBotService {
  private readonly bot = new Bot(config.telegramBotToken);
  private readonly bridge = new BridgeService();
  private nextRequestId = 1;
  private readonly latestDeliveredByChat = new Map<number, { requestId: number; text: string; at: number }>();
  private readonly activeRequestByChat = new Map<number, number>();
  private readonly requestProgressByChat = new Map<number, { requestId: number; phase: string; startedAt: number; updatedAt: number }>();
  private readonly lastPromptByChat = new Map<number, { prompt: string; at: number }>();
  private readonly pendingAssistantQuestionByChat = new Map<number, { text: string; at: number; source: "live" | "cache" | "persisted" }>();
  private readonly lastQuestionAlertByChat = new Map<number, { text: string; at: number }>();
  private readonly stateStore = new ChatStateStore();
  private readonly photoAutoSubmitByChat = new Map<number, boolean>();
  private readonly pendingAttachmentByChat = new Map<
    number,
    Array<{ kind: "photo" | "document"; createdAt: number; fileName?: string }>
  >();
  private restartFlag: boolean = false;

  constructor() {
    this.restartFlag = this.stateStore.getFlag("restart_pending") === true;
    if (this.restartFlag) {
      // Clear immediately to avoid repeated notices
      this.stateStore.setFlag("restart_pending", false);
    }
  }

  async notifyAllUsers(text: string): Promise<void> {
    const userIds = config.allowedTelegramUserIds;
    if (userIds.length === 0) {
      logger.debug("notifyAllUsers: no allowed user IDs configured, skipping");
      return;
    }
    for (const uid of userIds) {
      try {
        await this.bot.api.sendMessage(Number(uid), text, { link_preview_options: { is_disabled: true } });
      } catch (error) {
        logger.warn({ error, userId: uid }, "Failed to send preflight notification to user");
      }
    }
  }

  start(): void {
    this.bot.start();
    if (this.restartFlag) {
      // Notify all users bridge is back after restart
      void this.notifyAllUsers("Bridge restarted and is now online.");
      this.restartFlag = false;
    }
    this.bot.on("message", async (ctx) => {
      try {
        if (ctx.message) {
          await this.handleMessage(ctx.message);
        }
      } catch (error) {
        logger.error({ error }, "Failed to handle Telegram message");
        if (ctx.chat?.id) {
          await this.bot.api.sendMessage(ctx.chat.id, "Request failed. Check bridge logs for details.");
        }
      }
    });

    this.bot.on("callback_query", async (ctx) => {
      try {
        if (ctx.callbackQuery) {
          await this.handleCallbackQuery(ctx.callbackQuery);
        }
      } catch (error) {
        logger.error({ error }, "Failed to handle Telegram callback");
        if (ctx.callbackQuery?.message?.chat.id) {
          await this.sendText(ctx.callbackQuery.message.chat.id, "Action failed. Check bridge logs for details.");
        }
      }
    });

    this.bot.catch((err) => {
      logger.error({ error: err.error }, "Telegram bot error");
    });

    this.bot.start().catch((error) => {
      logger.error({ error }, "Telegram polling fatal error");
    });
  }

  private isAllowedUser(msg: Message): boolean {
    if (config.allowedTelegramUserIds.length === 0) {
      return true;
    }
    const userId = msg.from?.id?.toString();
    return !!userId && config.allowedTelegramUserIds.includes(userId);
  }

  private async handleMessage(msg: Message): Promise<void> {
    logger.info(
      {
        chatId: msg.chat.id,
        userId: msg.from?.id,
        hasText: Boolean(msg.text),
        hasPhoto: Boolean(msg.photo && msg.photo.length > 0),
        hasDocument: Boolean(msg.document)
      },
      "Telegram message received"
    );

    if (!this.isAllowedUser(msg)) {
      await this.sendText(msg.chat.id, "Unauthorized user.");
      return;
    }

    const text = msg.text?.trim();
    if (msg.photo && msg.photo.length > 0) {
      await this.handlePhotoMessage(msg);
      return;
    }
    if (msg.document) {
      await this.handleDocumentMessage(msg);
      return;
    }

    if (!text) {
      return;
    }

    // Any user-authored non-command text is considered a response to prior assistant questions.
    if (!text.startsWith("/")) {
      this.pendingAssistantQuestionByChat.delete(msg.chat.id);
    }

    const pendingAttachment = this.dequeuePendingAttachment(msg.chat.id);

    if (text === "/models") {
      await this.sendText(msg.chat.id, await this.withTimeout(this.bridge.listModels(), "Model listing timed out."));
      return;
    }

    if (text.startsWith("/model")) {
      const modelArg = text.replace("/model", "").trim();
      if (!modelArg) {
        await this.sendText(msg.chat.id, await this.withTimeout(this.bridge.getModel(), "Model detection timed out."));
      } else {
        await this.sendText(msg.chat.id, await this.withTimeout(this.bridge.setModel(modelArg), "Model switch timed out."));
      }
      return;
    }

    if (text.startsWith("/mode")) {
      await this.handleModeCommand(msg.chat.id, text);
      return;
    }
    if (text === "/ask" || text === "/plan" || text === "/code" || text === "/agent") {
      const aliasMode = text === "/agent" ? "code" : text.replace("/", "");
      await this.handleModeCommand(msg.chat.id, `/mode ${aliasMode}`);
      return;
    }

    if (text.startsWith("/photomode")) {
      await this.handlePhotoModeCommand(msg.chat.id, text);
      return;
    }

    if (text.startsWith("/attach")) {
      await this.handleAttachCommand(msg.chat.id, text);
      return;
    }

    if (text === "/newchat") {
      const status = await this.bridge.newChat();
      if (this.shouldResetStateAfterNewChat(status)) {
        this.resetChatState(msg.chat.id);
      }
      await this.sendText(msg.chat.id, status);
      return;
    }

    if (text === "/context") {
      await this.sendText(msg.chat.id, await this.withTimeout(this.bridge.contextStatus(), "Context request timed out."));
      return;
    }

    if (text === "/usage") {
      await this.sendText(msg.chat.id, await this.withTimeout(this.bridge.usageStatus(), "Usage request timed out."));
      return;
    }

    if (text === "/queue") {
      await this.sendText(msg.chat.id, this.queueStatus(msg.chat.id));
      return;
    }

    if (text.startsWith("/history")) {
      await this.sendText(msg.chat.id, this.historyStatus(msg.chat.id, text));
      return;
    }

    if (text === "/clearqueue") {
      await this.sendText(msg.chat.id, this.clearQueue(msg.chat.id));
      return;
    }

    if (text === "/progress") {
      await this.sendText(msg.chat.id, this.progressStatus(msg.chat.id));
      return;
    }
    if (text === "/restart") {
      this.stateStore.setFlag("restart_pending", true);
      await this.sendText(msg.chat.id, await this.bridge.restart());
      return;
    }

    if (text.startsWith("/cancel")) {
      const arg = text.replace("/cancel", "").trim().toLowerCase();
      await this.sendText(msg.chat.id, arg === "all" ? this.cancelAllActiveRequests() : this.cancelActiveRequest(msg.chat.id));
      return;
    }

    if (text.startsWith("/resume")) {
      await this.handleResumeCommand(msg.chat.id, text);
      return;
    }
    if (text.startsWith("/choose")) {
      await this.handleChooseCommand(msg.chat.id, text);
      return;
    }

    if (text === "/chats") {
      await this.sendText(msg.chat.id, await this.bridge.listChats());
      return;
    }

    if (text === "/targets") {
      await this.sendText(msg.chat.id, await this.bridge.listChats());
      return;
    }

    if (text.startsWith("/target")) {
      await this.handleTargetCommand(msg.chat.id, text);
      return;
    }

    if (text === "/diag") {
      await this.sendText(msg.chat.id, await this.bridge.diagnostics(), { sanitize: false });
      return;
    }

    if (text === "/last") {
      await this.handleLastCommand(msg.chat.id);
      return;
    }

    if (text === "/help all") {
      await this.sendText(msg.chat.id, this.helpTextAll(), { reply_markup: this.quickActionsKeyboard() });
      return;
    }

    if (text === "/start" || text === "/help") {
      await this.sendText(msg.chat.id, this.helpTextCompact(), { reply_markup: this.quickActionsKeyboard() });
      return;
    }

    if (text.startsWith("/") && (msg.chat.type === "group" || msg.chat.type === "supergroup")) {
      // Unknown slash commands in group chats should not spam shared channels.
      return;
    }

    await this.bot.api.sendChatAction(msg.chat.id, "typing");
    if (pendingAttachment) {
      await this.handleRelayWithFollowup(msg.chat.id, text, pendingAttachment.kind, pendingAttachment.fileName);
      return;
    }
    await this.handleRelayWithFollowup(msg.chat.id, text);
  }

  private async handleCallbackQuery(query: CallbackQuery): Promise<void> {
    await this.bot.api.answerCallbackQuery(query.id);
    const chatId = query.message?.chat.id;
    const data = query.data;
    if (!chatId || !data || !data.startsWith("cmd:")) {
      return;
    }
    const command = data.slice(4);
    if (!command) {
      return;
    }

    if (command === "/models") {
      await this.sendText(chatId, await this.withTimeout(this.bridge.listModels(), "Model listing timed out."));
      return;
    }

    if (command.startsWith("/mode")) {
      await this.handleModeCommand(chatId, command);
      return;
    }
    if (command === "/ask" || command === "/plan" || command === "/code" || command === "/agent") {
      const aliasMode = command === "/agent" ? "code" : command.replace("/", "");
      await this.handleModeCommand(chatId, `/mode ${aliasMode}`);
      return;
    }
    if (command === "/newchat") {
      const status = await this.bridge.newChat();
      if (this.shouldResetStateAfterNewChat(status)) {
        this.resetChatState(chatId);
      }
      await this.sendText(chatId, status);
      return;
    }
    if (command === "/context") {
      await this.sendText(chatId, await this.withTimeout(this.bridge.contextStatus(), "Context request timed out."));
      return;
    }
    if (command === "/usage") {
      await this.sendText(chatId, await this.withTimeout(this.bridge.usageStatus(), "Usage request timed out."));
      return;
    }
    if (command === "/queue") {
      await this.sendText(chatId, this.queueStatus(chatId));
      return;
    }
    if (command.startsWith("/history")) {
      await this.sendText(chatId, this.historyStatus(chatId, command));
      return;
    }
    if (command === "/clearqueue") {
      await this.sendText(chatId, this.clearQueue(chatId));
      return;
    }
    if (command === "/progress") {
      await this.sendText(chatId, this.progressStatus(chatId));
      return;
    }
    if (command === "/restart") {
      this.stateStore.setFlag("restart_pending", true);
      await this.sendText(chatId, await this.bridge.restart());
      return;
    }
    if (command === "/cancel") {
      await this.sendText(chatId, this.cancelActiveRequest(chatId));
      return;
    }
    if (command === "/cancel_all") {
      await this.sendText(chatId, this.cancelAllActiveRequests());
      return;
    }
    if (command === "/resume") {
      await this.handleResumeCommand(chatId, "/resume");
      return;
    }
    if (command === "/targets") {
      await this.sendText(chatId, await this.bridge.listChats());
      return;
    }
    if (command === "/last") {
      await this.handleLastCommand(chatId);
      return;
    }
    if (command === "/help") {
      await this.sendText(chatId, this.helpTextCompact(), { reply_markup: this.quickActionsKeyboard() });
    }
  }

  private helpTextCompact(): string {
    const ide = config.bridgeIdeTarget === "windsurf" ? "Windsurf" : config.bridgeIdeTarget === "vscode" ? "VS Code" : "Cursor";
    const modeHelp = config.bridgeIdeTarget === "windsurf" || config.bridgeIdeTarget === "vscode" ? "ask|code|plan" : "ask|code|plan|debug";
    const vscodeNote =
      config.bridgeIdeTarget === "vscode"
        ? "- VS Code mode/new-chat only report success when confirmed; otherwise they return explicit unverified/failed status."
        : null;
    return [
      `# Gantry (${ide})`,
      "",
      "## Quick Actions",
      `- \`/newchat\` start a fresh ${ide} chat`,
      `- \`/mode ${modeHelp}\` switch working mode`,
      "- `/queue` view pending attachments",
      "- `/last` show the last AI reply",
      "- `/targets` list chat targets",
      "- `/resume` continue from where we left off",
      "",
      "## Common Commands",
      "- `/context`, `/usage`, `/targets`",
      "- `/resume [optional instruction]`, `/cancel [all]`",
      "- `/choose A|B|C|D <custom>` answer pending questions quickly",
      "- `/history [count|clear]`, `/clearqueue`",
      "",
      "## Notes",
      `- Any non-command text is relayed to ${ide}.`,
      `- Photo/document messages attach to the active ${ide} composer.`,
      ...(vscodeNote ? [vscodeNote] : []),
      "- For full command reference use `/help all`."
    ].join("\n");
  }

  private helpTextAll(): string {
    const ide = config.bridgeIdeTarget === "windsurf" ? "Windsurf" : config.bridgeIdeTarget === "vscode" ? "VS Code" : "Cursor";
    const modeHelp = config.bridgeIdeTarget === "windsurf" || config.bridgeIdeTarget === "vscode" ? "ask|code|plan" : "ask|code|plan|debug";
    const vscodeBoundaryNote =
      config.bridgeIdeTarget === "vscode"
        ? "- VS Code mode/new-chat use strict confirmation semantics: switched only on exact Ask/Agent/Plan or new-chat signal; otherwise explicit unverified/failed."
        : null;
    return [
      `# Gantry (${ide}) - Full Help`,
      "",
      "## Core",
      `- \`/newchat\` start a new chat in ${ide}`,
      `- \`/mode ${modeHelp}\` switch ${ide} mode`,
      "- `/model [model-name]` show current model or switch to another",
      "- `/models` list currently available model names for copy/paste",
      "- `/last` show latest assistant output",
      "- `/resume [optional instruction]` continue previous work",
      "- `/choose A|B|C|D <custom>` answer latest assistant question",
      "",
      "## Status",
      "- `/context` show context estimate",
      "- `/usage` show usage diagnostics",
      "- `/progress` show active request progress",
      "- `/targets` list available targets",
      "- `/target <index>|auto` pin or unpin target",
      "- `/chats` alias for target list/status",
      "- `/diag` show bridge diagnostics",
      "",
      "## Attachments",
      "- `/photomode auto|manual|status` set photo send behavior",
      "- `/attach <absolute-path> | optional prompt` attach local document",
      "- `/queue` show queued attachments",
      "- `/clearqueue` clear queued attachments",
      "",
      "## History & Control",
      "- `/history [optional count|clear]` show or clear recent responses",
      "- `/cancel [all]` cancel active request(s)",
      "- `/choose multi A,C` choose multiple options",
      "- `/choose multi A,C,D:custom text` include custom option in multi-choice",
      "",
      "## Behavior",
      `- Non-command text is relayed to ${ide}.`,
      "- Unknown slash commands in groups are silently ignored.",
      ...(vscodeBoundaryNote ? [vscodeBoundaryNote] : []),
      "- If assistant asks a question, `/last` highlights that input is needed."
    ].join("\n");
  }

  private quickActionsKeyboard(): InlineKeyboardMarkup {
    if (config.bridgeIdeTarget === "windsurf") {
      return {
        inline_keyboard: [
          [
            { text: "New chat", callback_data: "cmd:/newchat" },
            { text: "Last", callback_data: "cmd:/last" }
          ],
          [
            { text: "Mode Ask", callback_data: "cmd:/mode ask" },
            { text: "Mode Code", callback_data: "cmd:/mode code" }
          ],
          [
            { text: "Mode Plan", callback_data: "cmd:/mode plan" },
            { text: "Context %", callback_data: "cmd:/context" }
          ],
          [
            { text: "Restart", callback_data: "cmd:/restart" },
            { text: "Help", callback_data: "cmd:/help" }
          ]
        ]
      };
    }

    return {
      inline_keyboard: [
        [
          { text: "New chat", callback_data: "cmd:/newchat" },
          { text: "Last", callback_data: "cmd:/last" }
        ],
        [
          { text: "Mode Ask", callback_data: "cmd:/mode ask" },
          { text: "Mode Code", callback_data: "cmd:/mode code" }
        ],
        [
          { text: "Mode Plan", callback_data: "cmd:/mode plan" },
          { text: "Context %", callback_data: "cmd:/context" }
        ],
        [
          { text: "Restart", callback_data: "cmd:/restart" },
          { text: "Help", callback_data: "cmd:/help" }
        ]
      ]
    };
  }

  private async handleLastCommand(chatId: number): Promise<void> {
    const latest = await this.bridge.latestResponse();
    const cached = this.latestDeliveredByChat.get(chatId);
    const stored = this.stateStore.getLastDelivered(chatId);
    const lastPrompt = this.lastPromptByChat.get(chatId)?.prompt ?? this.stateStore.getLastPrompt(chatId)?.prompt ?? null;

    const chooseCandidate = (
      value: string | null | undefined,
      source: "live" | "cache" | "persisted"
    ): { text: string; source: "live" | "cache" | "persisted" } | null => {
      if (!value) return null;
      if (this.isPendingCaptureMessage(value) || this.isInterimDeliveredMessage(value)) return null;
      if (this.looksLikePromptEcho(value, lastPrompt)) return null;
      return { text: value, source };
    };

    const candidate =
      chooseCandidate(latest, "live") ??
      chooseCandidate(cached?.text, "cache") ??
      chooseCandidate(stored?.text, "persisted");

    if (candidate) {
      if (this.looksLikeAssistantQuestion(candidate.text)) {
        this.pendingAssistantQuestionByChat.set(chatId, {
          text: candidate.text,
          at: Date.now(),
          source: candidate.source
        });
        await this.sendText(
          chatId,
          [
            "Assistant is waiting for your input.",
            "",
            `Latest question (${candidate.source}):`,
            candidate.text,
            "",
              "Reply directly, use /resume <your answer>, or quick-pick with /choose A|B|C|D <custom>."
          ].join("\n")
        );
        return;
      }
      await this.sendText(chatId, `Latest assistant response (${candidate.source}):\n${candidate.text}`);
      return;
    }

    const pendingQuestion = this.pendingAssistantQuestionByChat.get(chatId);
    if (pendingQuestion) {
      await this.sendText(
        chatId,
        [
          "Assistant is still waiting for your input.",
          "",
          "Last known question:",
          pendingQuestion.text,
          "",
          "Reply directly in chat, use /resume <your answer>, or quick-pick with /choose A|B|C|D <custom>."
        ].join("\n")
      );
      return;
    }

    await this.sendText(chatId, "No assistant response snippet available yet for this chat.");
  }

  private async handlePhotoMessage(msg: Message): Promise<void> {
    const largestPhoto = msg.photo?.at(-1);
    if (!largestPhoto) {
      await this.sendText(msg.chat.id, "Photo payload missing.");
      return;
    }

    const downloadDir = join(process.cwd(), "tmp", "telegram-images");
    mkdirSync(downloadDir, { recursive: true });

    const downloadedPath = await this.downloadFile(largestPhoto.file_id, downloadDir);
    const autoSubmit = this.getPhotoAutoSubmitForChat(msg.chat.id);
    const photoOptions: { autoSubmit?: boolean; prompt?: string } = { autoSubmit };
    if (msg.caption?.trim()) {
      photoOptions.prompt = msg.caption.trim();
    }
    const status = await this.bridge.injectPhoto(downloadedPath, photoOptions);
    const hasCaption = Boolean(msg.caption?.trim());
    if (!hasCaption && status.includes("Type your prompt and send manually")) {
      this.enqueuePendingAttachment(msg.chat.id, { kind: "photo", createdAt: Date.now() });
      await this.sendText(
        msg.chat.id,
        `${status}\nNext non-command text message will be relayed with this pending attachment context.`
      );
      return;
    }
    await this.sendText(msg.chat.id, status);
  }

  private async handleDocumentMessage(msg: Message): Promise<void> {
    const document = msg.document;
    if (!document) {
      await this.sendText(msg.chat.id, "Document payload missing.");
      return;
    }

    const downloadDir = join(process.cwd(), "tmp", "telegram-images");
    mkdirSync(downloadDir, { recursive: true });

    const downloadedPath = await this.downloadFile(document.file_id, downloadDir);
    const autoSubmit = this.getPhotoAutoSubmitForChat(msg.chat.id);
    const attachOptions: { autoSubmit?: boolean; fileName?: string; mimeType?: string; prompt?: string } = {
      autoSubmit
    };
    if (document.file_name) attachOptions.fileName = document.file_name;
    if (document.mime_type) attachOptions.mimeType = document.mime_type;
    if (msg.caption?.trim()) {
      attachOptions.prompt = msg.caption.trim();
    }
    const status = await this.bridge.injectDocument(downloadedPath, attachOptions);
    const hasCaption = Boolean(msg.caption?.trim());
    if (!hasCaption && status.includes("Type your prompt and send manually")) {
      const pending: { kind: "photo" | "document"; createdAt: number; fileName?: string } = {
        kind: "document",
        createdAt: Date.now()
      };
      if (document.file_name) pending.fileName = document.file_name;
      this.enqueuePendingAttachment(msg.chat.id, pending);
      await this.sendText(
        msg.chat.id,
        `${status}\nTip: add a caption to the file message to auto-send with text, or send prompt as next message.`
      );
      return;
    }
    await this.sendText(msg.chat.id, status);
  }

  private async handleAttachCommand(chatId: number, text: string): Promise<void> {
    const rawArg = text.replace("/attach", "").trim();
    if (!rawArg) {
      await this.sendText(chatId, "Usage: /attach <absolute-path> | optional prompt");
      return;
    }

    const normalizedArg = this.normalizeAttachPath(rawArg);
    const attachParsed = this.parseAttachArg(normalizedArg);
    if (!this.isAbsoluteWindowsPath(attachParsed.path)) {
      await this.sendText(chatId, "Attach path must be an absolute Windows path (for example C:\\\\folder\\\\file.pdf).");
      return;
    }

    try {
      await access(attachParsed.path);
    } catch {
      await this.sendText(chatId, `File not found or not accessible: ${attachParsed.path}`);
      return;
    }

    const autoSubmit = this.getPhotoAutoSubmitForChat(chatId);
    const attachCommandOptions: { autoSubmit?: boolean; fileName?: string; prompt?: string } = {
      autoSubmit,
      fileName: basename(attachParsed.path)
    };
    if (attachParsed.prompt) {
      attachCommandOptions.prompt = attachParsed.prompt;
    }
    const status = await this.bridge.injectDocument(attachParsed.path, attachCommandOptions);
    if (!attachParsed.prompt && status.includes("Type your prompt and send manually")) {
      this.enqueuePendingAttachment(chatId, {
        kind: "document",
        createdAt: Date.now(),
        fileName: basename(attachParsed.path)
      });
      await this.sendText(
        chatId,
        `${status}\nTip: add \`| your prompt\` to /attach to auto-send, or send prompt as next message.`
      );
      return;
    }
    await this.sendText(chatId, status);
  }

  private async handlePhotoModeCommand(chatId: number, text: string): Promise<void> {
    const arg = text.replace("/photomode", "").trim().toLowerCase();
    if (!arg || arg === "status") {
      const value = this.getPhotoAutoSubmitForChat(chatId) ? "auto" : "manual";
      await this.sendText(
        chatId,
        `Photo mode is currently ${value}.\nUse /photomode auto or /photomode manual to change behavior.`
      );
      return;
    }

    if (arg === "auto") {
      this.photoAutoSubmitByChat.set(chatId, true);
      await this.sendText(chatId, "Photo mode set to auto: image attach + auto-send.");
      return;
    }

    if (arg === "manual") {
      this.photoAutoSubmitByChat.set(chatId, false);
      await this.sendText(chatId, "Photo mode set to manual: image attaches only, you type and send.");
      return;
    }

    await this.sendText(chatId, "Invalid photo mode. Use: /photomode auto|manual|status");
  }

  private async handleModeCommand(chatId: number, text: string): Promise<void> {
    const mode = text.replace("/mode", "").trim().toLowerCase() as BridgeMode;
    const validModes =
      config.bridgeIdeTarget === "windsurf" || config.bridgeIdeTarget === "vscode"
        ? ["ask", "code", "plan"]
        : ["ask", "code", "plan", "debug"];
    if (!validModes.includes(mode)) {
      await this.sendText(chatId, `Invalid mode. Use: /mode ${validModes.join("|")}`);
      return;
    }

    await this.sendText(chatId, await this.bridge.switchMode(mode));
  }

  private async handleTargetCommand(chatId: number, text: string): Promise<void> {
    const arg = text.replace("/target", "").trim().toLowerCase();
    if (!arg) {
      await this.sendText(chatId, await this.bridge.targetStatus());
      return;
    }

    if (arg === "auto") {
      await this.sendText(chatId, await this.bridge.selectTarget("auto"));
      return;
    }

    const index = Number(arg);
    if (!Number.isInteger(index) || index <= 0) {
      await this.sendText(chatId, "Invalid target. Use /target <index>, /target auto, or /targets.");
      return;
    }

    await this.sendText(chatId, await this.bridge.selectTarget(index));
  }

  private async withTimeout(task: Promise<string>, timeoutMessage: string): Promise<string> {
    const timeout = new Promise<string>((resolve) => {
      setTimeout(() => resolve(timeoutMessage), config.telegramRequestTimeoutMs);
    });
    return await Promise.race([task, timeout]);
  }

  private progressStatus(chatId: number): string {
    const progress = this.requestProgressByChat.get(chatId);
    if (!progress) {
      return "No active request in progress.";
    }
    const elapsedSec = Math.max(0, Math.round((Date.now() - progress.startedAt) / 1000));
    const lines = [`Request #${progress.requestId} is ${progress.phase}.`, `Elapsed: ${elapsedSec}s.`];
    const cached = this.latestDeliveredByChat.get(chatId);
    if (cached && cached.requestId === progress.requestId && !this.isInterimDeliveredMessage(cached.text)) {
      lines.push(`Last delivered snippet: ${this.preview(cached.text)}`);
    }
    return lines.join("\n");
  }

  private queueStatus(chatId: number): string {
    const queue = this.getAttachmentQueue(chatId);
    if (queue.length === 0) {
      return "Attachment queue is empty.";
    }
    const lines = queue.slice(0, 5).map((item, index) => {
      const ageSec = Math.max(0, Math.round((Date.now() - item.createdAt) / 1000));
      const file = item.fileName ? ` (${item.fileName})` : "";
      return `${index + 1}. ${item.kind}${file} - queued ${ageSec}s ago`;
    });
    return `Attachment queue (${queue.length}):\n${lines.join("\n")}`;
  }

  private historyStatus(chatId: number, text: string): string {
    const arg = text.replace("/history", "").trim();
    if (arg.toLowerCase() === "clear") {
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
      return "No response history available yet for this chat.";
    }
    const lines = history.map((item, index) => {
      const when = new Date(item.at).toISOString();
      return `${index + 1}. [${when}] ${this.preview(item.text, 220)}`;
    });
    return `Recent responses (${history.length}):\n${lines.join("\n")}`;
  }

  private clearQueue(chatId: number): string {
    const queue = this.getAttachmentQueue(chatId);
    const removed = queue.length;
    this.pendingAttachmentByChat.delete(chatId);
    if (removed === 0) {
      return "Attachment queue is already empty.";
    }
    return `Cleared ${removed} queued attachment item(s).`;
  }

  private cancelActiveRequest(chatId: number): string {
    const requestId = this.activeRequestByChat.get(chatId);
    if (!requestId) {
      return "No active request to cancel.";
    }
    this.activeRequestByChat.delete(chatId);
    const progress = this.requestProgressByChat.get(chatId);
    if (progress) {
      this.requestProgressByChat.set(chatId, {
        ...progress,
        phase: "cancelled",
        updatedAt: Date.now()
      });
    }
    return `Cancelled active request #${requestId}. Pending follow-up loop will stop.`;
  }

  private cancelAllActiveRequests(): string {
    const entries = Array.from(this.activeRequestByChat.entries());
    if (entries.length === 0) {
      return "No active requests to cancel.";
    }
    for (const [chatId, requestId] of entries) {
      this.activeRequestByChat.delete(chatId);
      const progress = this.requestProgressByChat.get(chatId);
      if (progress) {
        this.requestProgressByChat.set(chatId, {
          ...progress,
          phase: "cancelled",
          updatedAt: Date.now()
        });
      }
      logger.info({ chatId, requestId }, "Cancelled active request via /cancel all");
    }
    return `Cancelled ${entries.length} active request(s).`;
  }

  private preview(text: string, limit = 160): string {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (value.length <= limit) {
      return value;
    }
    return `${value.slice(0, limit)}...`;
  }

  private resetChatState(chatId: number): void {
    this.latestDeliveredByChat.delete(chatId);
    this.activeRequestByChat.delete(chatId);
    this.requestProgressByChat.delete(chatId);
    this.lastPromptByChat.delete(chatId);
    this.pendingAssistantQuestionByChat.delete(chatId);
    this.lastQuestionAlertByChat.delete(chatId);
    this.photoAutoSubmitByChat.delete(chatId);
    this.pendingAttachmentByChat.delete(chatId);
    this.stateStore.clearChat(chatId);
  }

  private async handleResumeCommand(chatId: number, text: string): Promise<void> {
    const arg = text.replace("/resume", "").trim();
    if (arg) {
      await this.handleRelayWithFollowup(chatId, arg);
      return;
    }
    const previous = this.lastPromptByChat.get(chatId);
    const persisted = this.stateStore.getLastPrompt(chatId);
    const sourcePrompt = previous?.prompt ?? persisted?.prompt;
    if (!sourcePrompt) {
      await this.sendText(chatId, "No previous prompt found for this chat. Send a prompt first or use /resume <instruction>.");
      return;
    }
    const resumePrompt = [
      "Continue the previous task and provide a concise progress update.",
      `Original request: ${sourcePrompt}`
    ].join("\n");
    await this.handleRelayWithFollowup(chatId, resumePrompt);
  }

  private async handleChooseCommand(chatId: number, text: string): Promise<void> {
    const pending = this.pendingAssistantQuestionByChat.get(chatId);
    if (!pending) {
      await this.sendText(chatId, "No pending assistant question. Use /last first if needed.");
      return;
    }

    const raw = text.replace(/^\/choose/i, "").trim();
    if (!raw) {
      await this.sendText(
        chatId,
        [
          "Usage:",
          "- `/choose A`",
          "- `/choose B`",
          "- `/choose C`",
          "- `/choose D your custom answer`",
          "- `/choose multi A,C`",
          "- `/choose multi A,C,D:your custom answer`"
        ].join("\n")
      );
      return;
    }

    const lower = raw.toLowerCase();
    let relayPrompt: string | null = null;
    if (lower.startsWith("multi ")) {
      relayPrompt = this.buildMultiChoiceRelayPrompt(pending.text, raw.slice(6).trim());
    } else {
      relayPrompt = this.buildSingleChoiceRelayPrompt(pending.text, raw);
    }

    if (!relayPrompt) {
      await this.sendText(
        chatId,
        [
          "Invalid /choose format.",
          "",
          "Valid examples:",
          "- `/choose A`",
          "- `/choose D run this in safe read-only mode first`",
          "- `/choose multi A,B`",
          "- `/choose multi B,D:also include logging details`"
        ].join("\n")
      );
      return;
    }

    this.pendingAssistantQuestionByChat.delete(chatId);
    this.lastQuestionAlertByChat.delete(chatId);
    await this.handleRelayWithFollowup(chatId, relayPrompt);
  }

  private async handleRelayWithFollowup(
    chatId: number,
    prompt: string,
    pendingAttachmentKind?: "photo" | "document",
    pendingAttachmentFileName?: string
  ): Promise<void> {
    const policy = TextSecurityGuard.evaluatePrompt(prompt);
    if (!policy.allowed) {
      await this.sendText(chatId, policy.reason ?? "Blocked by safety policy.");
      return;
    }
    const requestId = this.nextRequestId++;
    const startedAt = Date.now();
    this.lastPromptByChat.set(chatId, { prompt, at: startedAt });
    this.stateStore.recordPrompt(chatId, prompt, startedAt);
    this.activeRequestByChat.set(chatId, requestId);
    this.requestProgressByChat.set(chatId, {
      requestId,
      phase: "running",
      startedAt,
      updatedAt: startedAt
    });
    const baselineSnippet = await this.bridge.latestResponse();
    const relayTask = pendingAttachmentKind
      ? this.bridge.relayPromptForPendingAttachment(prompt, pendingAttachmentKind, pendingAttachmentFileName)
      : this.bridge.relayPrompt(prompt);
    const timeoutMs = config.telegramRequestTimeoutMs;

    const first = await Promise.race([
      relayTask.then((text) => ({ kind: "result" as const, text })),
      new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), timeoutMs))
    ]);

    if (first.kind === "result") {
      await this.sendText(chatId, first.text);
      await this.capturePendingAssistantQuestion(chatId, first.text, "live");
      this.latestDeliveredByChat.set(chatId, { requestId, text: first.text, at: Date.now() });
      this.stateStore.recordDelivered(chatId, first.text, requestId);
      if (this.isPendingCaptureMessage(first.text)) {
        this.requestProgressByChat.set(chatId, {
          requestId,
          phase: "waiting for response capture",
          startedAt,
          updatedAt: Date.now()
        });
        await this.sendDelayedFollowup(chatId, requestId, baselineSnippet, 45000);
      } else {
        this.requestProgressByChat.delete(chatId);
        if (this.activeRequestByChat.get(chatId) === requestId) {
          this.activeRequestByChat.delete(chatId);
        }
      }
      return;
    }

    this.requestProgressByChat.set(chatId, {
      requestId,
      phase: "waiting (timeout follow-up pending)",
      startedAt,
      updatedAt: Date.now()
    });
    await this.sendText(
      chatId,
      "Prompt submitted. Response is taking longer than expected; I will send a follow-up automatically."
    );

    try {
      const final = await relayTask;
      if (!this.isPendingCaptureMessage(final)) {
        await this.sendText(chatId, final);
        await this.capturePendingAssistantQuestion(chatId, final, "live");
        this.latestDeliveredByChat.set(chatId, { requestId, text: final, at: Date.now() });
        this.stateStore.recordDelivered(chatId, final, requestId);
        this.requestProgressByChat.delete(chatId);
        if (this.activeRequestByChat.get(chatId) === requestId) {
          this.activeRequestByChat.delete(chatId);
        }
        return;
      }
      this.requestProgressByChat.set(chatId, {
        requestId,
        phase: "waiting for response capture",
        startedAt,
        updatedAt: Date.now()
      });
      await this.sendDelayedFollowup(chatId, requestId, baselineSnippet, 45000);
    } catch (error) {
      logger.warn({ error }, "Relay follow-up failed");
      await this.sendText(chatId, "Request failed while waiting for delayed follow-up.");
      this.requestProgressByChat.delete(chatId);
      if (this.activeRequestByChat.get(chatId) === requestId) {
        this.activeRequestByChat.delete(chatId);
      }
    }
  }

  private async sendDelayedFollowup(
    chatId: number,
    requestId: number,
    baselineSnippet: string | null,
    maxWaitMs: number
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const activeId = this.activeRequestByChat.get(chatId);
      if (activeId !== requestId) {
        // A newer request exists for this chat, so stop stale follow-up.
        return;
      }
      const latest = await this.bridge.latestResponse();
      if (
        latest &&
        latest.trim().length >= 8 &&
        latest !== baselineSnippet &&
        !this.isPendingCaptureMessage(latest)
      ) {
        await this.sendText(chatId, `Follow-up response:\n${latest}`);
        await this.capturePendingAssistantQuestion(chatId, latest, "live");
        this.latestDeliveredByChat.set(chatId, { requestId, text: latest, at: Date.now() });
        this.stateStore.recordDelivered(chatId, latest, requestId);
        this.requestProgressByChat.delete(chatId);
        if (this.activeRequestByChat.get(chatId) === requestId) {
          this.activeRequestByChat.delete(chatId);
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    await this.sendText(chatId, "Follow-up capture still unavailable. Use /last or /diag and retry.");
    this.requestProgressByChat.delete(chatId);
    if (this.activeRequestByChat.get(chatId) === requestId) {
      this.activeRequestByChat.delete(chatId);
    }
  }

  private isPendingCaptureMessage(text: string): boolean {
    const value = String(text || "").toLowerCase();
    return value.includes("response capture is pending") || value.includes("pending or unavailable");
  }

  private isInterimDeliveredMessage(text: string): boolean {
    const value = String(text || "").toLowerCase();
    return (
      value.includes("response capture is pending") ||
      value.includes("pending or unavailable") ||
      value.includes("prompt submitted. response is taking longer than expected") ||
      value.includes("i'm gathering") ||
      value.includes("i am gathering")
    );
  }

  private looksLikeAssistantQuestion(text: string): boolean {
    const value = String(text || "").trim();
    if (!value) return false;
    if (this.isPendingCaptureMessage(value) || this.isInterimDeliveredMessage(value)) {
      return false;
    }
    const lower = value.toLowerCase();
    const hasQuestionMark = value.includes("?");
    const hasInputCue =
      lower.includes("which option") ||
      lower.includes("which one") ||
      lower.includes("which do you want") ||
      lower.includes("do you want me to") ||
      lower.includes("how would you like") ||
      lower.includes("can you confirm") ||
      lower.includes("please confirm") ||
      lower.includes("i need") ||
      lower.includes("need your input") ||
      lower.includes("pick one") ||
      lower.includes("choose one") ||
      lower.includes("should i") ||
      lower.includes("which approach") ||
      lower.includes("which direction");
    return hasQuestionMark && hasInputCue;
  }

  private looksLikeMultipleChoice(text: string): boolean {
    const value = String(text || "").trim();
    if (!value) return false;
    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    if (lines.length === 0) return false;

    // Detect enumerated options like "1) ...", "A. ...", "Option 1: ...", "Option A: ..."
    const optionRegexes = [
      /^[-*•]?\s*(?:[1-9][0-9]?|[A-Da-d])\s*[\).:\-]\s+.+/,
      /^[-*•]?\s*option\s*(?:[1-9][0-9]?|[A-Da-d])\s*[:\-]\s+.+/i,
      /^[-*•]?\s*approach\s*(?:[1-9][0-9]?|[A-Da-d])\s*[:\-]\s+.+/i
    ];

    let optionCount = 0;
    for (const line of lines) {
      if (optionRegexes.some((re) => re.test(line))) {
        optionCount += 1;
      }
    }
    return optionCount >= 2; // Require at least two option-looking lines
  }

  private looksLikePromptEcho(candidate: string, prompt: string | null): boolean {
    if (!prompt) return false;
    const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
    const c = normalize(candidate);
    const p = normalize(prompt);
    if (!c || !p) return false;
    if (c === p) return true;
    if (c.length >= 24 && p.length >= 24 && (c.includes(p) || p.includes(c))) {
      return true;
    }
    return false;
  }

  private async capturePendingAssistantQuestion(
    chatId: number,
    text: string,
    source: "live" | "cache" | "persisted"
  ): Promise<void> {
    const isQuestion = this.looksLikeAssistantQuestion(text);
    const isMultiChoice = isQuestion && this.looksLikeMultipleChoice(text);

    if (isMultiChoice) {
      this.pendingAssistantQuestionByChat.set(chatId, { text, at: Date.now(), source });
      await this.sendQuestionAlert(chatId, text, "multi");
      return;
    }

    if (isQuestion) {
      // Generic question (no explicit options) — notify without /choose quick replies.
      this.pendingAssistantQuestionByChat.delete(chatId);
      await this.sendQuestionAlert(chatId, text, "generic");
      return;
    }

    this.pendingAssistantQuestionByChat.delete(chatId);
    this.lastQuestionAlertByChat.delete(chatId);
  }

  private async sendQuestionAlert(chatId: number, questionText: string, kind: "multi" | "generic" = "multi"): Promise<void> {
    const now = Date.now();
    const prev = this.lastQuestionAlertByChat.get(chatId);
    const normalize = (value: string) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const sameQuestion = prev && normalize(prev.text) === normalize(questionText);
    if (sameQuestion && now - prev.at < 90_000) {
      return;
    }
    this.lastQuestionAlertByChat.set(chatId, { text: questionText, at: now });

    if (kind === "generic") {
      await this.sendText(
        chatId,
        [
          "Action needed: assistant asked a question.",
          "",
          questionText,
          "",
          "Reply in chat or use `/resume <your answer>` to continue."
        ].join("\n")
      );
      return;
    }

    await this.sendText(
      chatId,
      [
        "Action needed: assistant asked a question.",
        "",
        "Quick replies:",
        "- `/choose A`",
        "- `/choose B`",
        "- `/choose C`",
        "- `/choose D your custom answer`",
        "- `/choose multi A,C`",
        "- `/choose multi A,C,D:your custom answer`",
        "",
        "You can also reply directly in chat or use `/resume <your answer>`."
      ].join("\n")
    );
  }

  private buildSingleChoiceRelayPrompt(question: string, rawChoice: string): string | null {
    const value = rawChoice.trim();
    if (!value) return null;
    const singleMatch = value.match(/^([abcdABCD])(?:\s+(.+))?$/);
    if (!singleMatch) return null;
    const label = (singleMatch[1] ?? "").toUpperCase();
    const custom = (singleMatch[2] ?? "").trim();
    if (label === "D" && custom.length === 0) {
      return null;
    }
    const instruction =
      label === "A"
        ? "Choose option A."
        : label === "B"
          ? "Choose option B."
          : label === "C"
            ? "Choose option C."
            : `Use this custom answer instead of predefined options: ${custom}`;

    return [
      "You asked me to choose from your previous question.",
      `Question: ${question}`,
      `Selection: ${label}${label === "D" ? " (custom)" : ""}`,
      instruction,
      "Proceed with this selection and continue the task."
    ].join("\n");
  }

  private buildMultiChoiceRelayPrompt(question: string, rawSelection: string): string | null {
    const csv = rawSelection.trim();
    if (!csv) return null;
    const tokens = csv.split(",").map((t) => t.trim()).filter(Boolean);
    if (tokens.length === 0) return null;

    const selected: Array<"A" | "B" | "C" | "D"> = [];
    let customText: string | null = null;
    for (const token of tokens) {
      if (/^[abcABC]$/.test(token)) {
        selected.push(token.toUpperCase() as "A" | "B" | "C");
        continue;
      }
      const dOnly = token.match(/^d$/i);
      if (dOnly) {
        return null;
      }
      const dCustom = token.match(/^d\s*:\s*(.+)$/i);
      if (dCustom) {
        selected.push("D");
        customText = (dCustom[1] ?? "").trim();
        if (!customText) return null;
        continue;
      }
      return null;
    }

    const dedup = Array.from(new Set(selected));
    if (dedup.length === 0) return null;
    if (dedup.includes("D") && !customText) return null;

    const customLine = customText ? `Custom D answer: ${customText}` : "";
    return [
      "You asked me to choose multiple options from your previous question.",
      `Question: ${question}`,
      `Selections: ${dedup.join(", ")}`,
      customLine,
      "Apply all selected options together and continue."
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  }

  private getPhotoAutoSubmitForChat(chatId: number): boolean {
    return this.photoAutoSubmitByChat.get(chatId) ?? true;
  }

  private getAttachmentQueue(chatId: number): Array<{ kind: "photo" | "document"; createdAt: number; fileName?: string }> {
    const queue = this.pendingAttachmentByChat.get(chatId) ?? [];
    const fresh = queue.filter((item) => Date.now() - item.createdAt <= 5 * 60 * 1000);
    this.pendingAttachmentByChat.set(chatId, fresh);
    return fresh;
  }

  private enqueuePendingAttachment(
    chatId: number,
    item: { kind: "photo" | "document"; createdAt: number; fileName?: string }
  ): void {
    const queue = this.getAttachmentQueue(chatId);
    queue.push(item);
    this.pendingAttachmentByChat.set(chatId, queue.slice(-10));
  }

  private dequeuePendingAttachment(
    chatId: number
  ): { kind: "photo" | "document"; createdAt: number; fileName?: string } | null {
    const queue = this.getAttachmentQueue(chatId);
    if (queue.length === 0) {
      return null;
    }
    const next = queue.shift() ?? null;
    this.pendingAttachmentByChat.set(chatId, queue);
    return next;
  }

  private normalizeAttachPath(input: string): string {
    let value = input.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).trim();
    }
    if (value.startsWith("@")) {
      value = value.slice(1).trim();
    }
    return value;
  }

  private parseAttachArg(value: string): { path: string; prompt?: string } {
    const parts = value.split("|");
    const path = parts[0]?.trim() ?? value.trim();
    const promptRaw = parts.slice(1).join("|").trim();
    if (!promptRaw) {
      return { path };
    }
    return { path, prompt: promptRaw };
  }

  private isAbsoluteWindowsPath(value: string): boolean {
    return /^[a-zA-Z]:\\/.test(value) || /^\\\\[^\\]+\\[^\\]+\\/.test(value);
  }

  private shouldResetStateAfterNewChat(status: string): boolean {
    const value = String(status || "").toLowerCase();
    return !(
      value.includes("unsupported") ||
      value.includes("not available") ||
      value.includes("not implemented") ||
      value.includes("failed")
    );
  }

  private async downloadFile(fileId: string, downloadDir: string): Promise<string> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) {
      throw new Error("Telegram file path not available");
    }
    const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download file: HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const localPath = join(downloadDir, basename(file.file_path));
    writeFileSync(localPath, buffer);
    return localPath;
  }

  private sanitizeForTelegram(text: string): string {
    const withoutAnsi = String(text || "").replace(/\x1B\[[0-9;]*m/g, "");
    const normalized = withoutAnsi.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n").map((line) => line.replace(/\s+$/g, ""));
    const kept: string[] = [];
    let blankRun = 0;
    for (const line of lines) {
      if (line.trim().length === 0) {
        blankRun += 1;
        if (blankRun > 2) continue;
        kept.push("");
        continue;
      }
      blankRun = 0;
      kept.push(line);
    }
    return kept.join("\n").trim();
  }

  private splitForTelegram(text: string, chunkSize = 3500): string[] {
    const value = this.sanitizeForTelegram(text);
    if (!value) return ["(empty response)"];
    if (value.length <= chunkSize) return [value];

    const chunks: string[] = [];
    let cursor = 0;
    while (cursor < value.length) {
      let end = Math.min(cursor + chunkSize, value.length);
      if (end < value.length) {
        const lastBreak = value.lastIndexOf("\n", end);
        if (lastBreak > cursor + 400) {
          end = lastBreak;
        }
      }
      const part = value.slice(cursor, end).trim();
      if (part) chunks.push(part);
      cursor = end;
    }
    return chunks;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private escapeHtmlAllowBasicTags(value: string): string {
    const escaped = this.escapeHtml(value);
    return escaped.replace(/&lt;(\/)?(b|strong|i|em|u|s|code|pre|br)&gt;/gi, "<$1$2>");
  }

  private formatChunkForTelegramHtml(text: string): string {
    const source = String(text || "");
    const codeBlocks: string[] = [];
    const withPlaceholders = source.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_all, code: string) => {
      const token = `@@CODEBLOCK_${codeBlocks.length}@@`;
      codeBlocks.push(`<pre>${this.escapeHtml(String(code || "").trim())}</pre>`);
      return token;
    });

    const lines = withPlaceholders.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const rawLine = lines[i] ?? "";
      const line = rawLine.trimEnd();
      const codePlaceholderMatch = line.match(/^@@CODEBLOCK_(\d+)@@$/);
      if (codePlaceholderMatch) {
        const idx = Number(codePlaceholderMatch[1]);
        out.push(codeBlocks[idx] || "");
        continue;
      }

      const codeHeader = line.match(/^code:\s*(.*)$/i);
      if (codeHeader) {
        const codeLines: string[] = [];
        const first = codeHeader[1] ?? "";
        if (first.trim().length > 0) {
          codeLines.push(first);
        }

        let j = i + 1;
        while (j < lines.length) {
          const nextRaw = lines[j] ?? "";
          const nextLine = nextRaw.trimEnd();
          const nextPlaceholder = nextLine.match(/^@@CODEBLOCK_(\d+)@@$/);
          if (nextPlaceholder) {
            break;
          }
          if (nextLine.trim().length === 0) {
            break;
          }
          const isLikelyCodeLine =
            /^\s+/.test(nextRaw) ||
            /^\d+[\)\.\:\-]\s*/.test(nextLine) ||
            /^[A-Za-z]\)\s*/.test(nextLine) ||
            /^[-*]\s+/.test(nextLine) ||
            /^\w+\s*[:=]\s*/.test(nextLine);
          if (!isLikelyCodeLine && codeLines.length > 0) {
            break;
          }
          codeLines.push(nextRaw);
          if (codeLines.length >= 24) break;
          j += 1;
        }

        if (codeLines.length > 0) {
          out.push(`<b>Code:</b>`);
          out.push(`<pre>${this.escapeHtml(codeLines.join("\n"))}</pre>`);
          i = j - 1;
        } else {
          out.push("<b>Code:</b>");
        }
        continue;
      }

      if (line.trim().length === 0) {
        out.push("");
        continue;
      }

      const heading = line.match(/^#{1,3}\s+(.+)$/) || line.match(/^[Tt]itle:\s*(.+)$/);
      if (heading) {
        const headingText = heading[1] ?? "";
        out.push(`<b>${this.escapeHtml(headingText.trim())}</b>`);
        continue;
      }

      const bullet = line.match(/^(\s*)([-*•])\s+(.+)$/);
      if (bullet) {
        const indent = (bullet[1] ?? "").replace(/\t/g, "  ");
        const bulletText = bullet[3] ?? "";
        const nbspIndent = this.escapeHtml(indent).replace(/ /g, "&nbsp;");
        out.push(`${nbspIndent}• ${this.formatInlineTelegramHtml(bulletText)}`);
        continue;
      }

      out.push(this.formatInlineTelegramHtml(line));
    }

    const combined = out
      .join("\n")
      .replace(/(\n\s*){3,}/g, "\n\n")
      .replace(/^(\n)+|(\n)+$/g, "")
      .trim();

    return combined.length > 0 ? combined : "(empty response)";
  }

  private formatInlineTelegramHtml(value: string): string {
    const source = String(value || "");
    if (!source.includes("`")) {
      return this.escapeHtmlAllowBasicTags(source);
    }
    const segments = source.split(/`([^`]+)`/g);
    const out: string[] = [];
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (segment === undefined) continue;
      if (i % 2 === 1) {
        out.push(`<code>${this.escapeHtml(segment)}</code>`);
      } else {
        out.push(this.escapeHtmlAllowBasicTags(segment));
      }
    }
    return out.join("");
  }

  private extractRetryAfterSeconds(error: unknown): number | null {
    if (error instanceof GrammyError && error.error_code === 429) {
      const params = error.parameters;
      if (typeof params.retry_after === "number" && params.retry_after > 0) {
        return params.retry_after;
      }
    }
    return null;
  }

  private async sendMessageWithRetry(
    chatId: number,
    text: string,
    options: { parse_mode?: "HTML" | "MarkdownV2" | "Markdown"; link_preview_options?: { is_disabled?: boolean }; reply_markup?: InlineKeyboardMarkup }
  ): Promise<void> {
    let attempt = 0;
    while (attempt < 3) {
      try {
        await this.bot.api.sendMessage(chatId, text, options);
        return;
      } catch (error) {
        const retryAfterSec = this.extractRetryAfterSeconds(error);
        if (!retryAfterSec || attempt >= 2) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, (retryAfterSec + 1) * 1000));
      }
      attempt += 1;
    }
  }

  private async sendText(
    chatId: number,
    text: string,
    options?: { reply_markup?: InlineKeyboardMarkup; sanitize?: boolean }
  ): Promise<void> {
    const safeText = options?.sanitize === false ? text : TextSecurityGuard.sanitizeOutbound(text);
    const parts = this.splitForTelegram(safeText);
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] ?? "";
      const prefix = parts.length > 1 ? `[${i + 1}/${parts.length}]\n` : "";
      const formatted = this.formatChunkForTelegramHtml(part);
      try {
        await this.sendMessageWithRetry(chatId, `${this.escapeHtml(prefix)}${formatted}`, {
          ...(options ?? {}),
          link_preview_options: { is_disabled: true },
          parse_mode: "HTML"
        });
      } catch (error) {
        logger.warn({ error }, "HTML Telegram formatting failed; falling back to plain text");
        await this.sendMessageWithRetry(chatId, `${prefix}${part}`, {
          ...(options ?? {}),
          link_preview_options: { is_disabled: true }
        });
      }
    }
  }
}
