import "dotenv/config";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ALLOWED_USER_IDS: z.string().default(""),
  BRIDGE_BACKEND_MODE: z.enum(["cdp", "api"]).default("cdp"),
  BRIDGE_IDE_TARGET: z.enum(["cursor", "windsurf", "vscode"]).default("cursor"),
  BRIDGE_API_AUTH_TOKEN: z.string().default(""),
  CURSOR_APP_EXE: z.string().default("Cursor"),
  CURSOR_REMOTE_DEBUG_URL: z.string().default("http://127.0.0.1:9222"),
  CURSOR_TARGET_TITLE_HINT: z.string().default("Cursor"),
  CURSOR_CHAT_INPUT_SELECTOR: z
    .string()
    .default('.tiptap.ProseMirror[contenteditable="true"], [class*="ai-input"] textarea, [class*="composer"] textarea, [class*="composer"] [role="textbox"]'),
  CURSOR_RESPONSE_SELECTOR: z
    .string()
    .default('.composer-rendered-message .anysphere-markdown-container-root, [class*="assistant-message"] [class*="markdown"], [class*="assistant"] [class*="markdown"]'),
  CURSOR_CONTEXT_SELECTOR: z.string().default(""),
  CURSOR_MODEL_SELECTOR: z.string().default('[class*="composer-unified-dropdown-model"]'),
  CURSOR_CONTEXT_REGION: z.string().default(""),
  CURSOR_CONTEXT_HOVER_POINT: z.string().default(""),
  CURSOR_ACTION_TIMEOUT_MS: z.coerce.number().default(30000),
  TELEGRAM_REQUEST_TIMEOUT_MS: z.coerce.number().default(120000),
  VSCODE_SQLITE_PATH: z.string().default(""),
  CURSOR_SQLITE_PATH: z.string().default(""),
  WINDSURF_REMOTE_DEBUG_URL: z.string().default("http://127.0.0.1:9223"),
  WINDSURF_TARGET_TITLE_HINT: z.string().default("Windsurf"),
  WINDSURF_CHAT_INPUT_SELECTOR: z.string().default('div[role="textbox"]'),
  WINDSURF_RESPONSE_SELECTOR: z.string().default('[class*="prose"]'),
  WINDSURF_MODE_SELECTOR: z.string().default('button'),
  WINDSURF_CONTEXT_SELECTOR: z.string().default(''),
  WINDSURF_MODEL_SELECTOR: z.string().default(''),
  WINDSURF_ACTION_TIMEOUT_MS: z.coerce.number().default(30000),
  WINDSURF_SQLITE_PATH: z.string().default(""),
  VSCODE_REMOTE_DEBUG_URL: z.string().default("http://127.0.0.1:9224"),
  VSCODE_TARGET_TITLE_HINT: z.string().default("Code"),
  VSCODE_CHAT_INPUT_SELECTOR: z.string().default('div[role="textbox"], textarea, [contenteditable="true"]'),
  VSCODE_RESPONSE_SELECTOR: z.string().default('[class*="markdown"], [role="document"], article'),
  VSCODE_MODE_SELECTOR: z.string().default(''),
  VSCODE_MODEL_SELECTOR: z.string().default(''),
  VSCODE_CONTEXT_SELECTOR: z.string().default(''),
  VSCODE_ACTION_TIMEOUT_MS: z.coerce.number().default(30000),
  CURSOR_API_KEY: z.string().default(""),
  CURSOR_API_BASE_URL: z.string().default("https://api.cursor.com"),
  CURSOR_API_REPOSITORY: z.string().default(""),
  CURSOR_API_MODEL: z.string().default(""),
  CURSOR_API_REF: z.string().default(""),
  CURSOR_API_TIMEOUT_MS: z.coerce.number().default(30000),
  DISCORD_ENABLED: z.string().default("false"),
  DISCORD_BOT_TOKEN: z.string().default(""),
  DISCORD_ALLOWED_USER_IDS: z.string().default(""),
  EMAIL_ENABLED: z.string().default("false"),
  EMAIL_ALLOWED_FROM: z.string().default(""),
  EMAIL_IMAP_HOST: z.string().default(""),
  EMAIL_IMAP_PORT: z.coerce.number().default(993),
  EMAIL_IMAP_SECURE: z.string().default("true"),
  EMAIL_IMAP_USER: z.string().default(""),
  EMAIL_IMAP_PASS: z.string().default(""),
  EMAIL_SMTP_HOST: z.string().default(""),
  EMAIL_SMTP_PORT: z.coerce.number().default(587),
  EMAIL_SMTP_SECURE: z.string().default("false"),
  EMAIL_SMTP_USER: z.string().default(""),
  EMAIL_SMTP_PASS: z.string().default(""),
  EMAIL_POLL_INTERVAL_MS: z.coerce.number().default(30000),
  FEISHU_ENABLED: z.string().default("false"),
  FEISHU_APP_ID: z.string().default(""),
  FEISHU_APP_SECRET: z.string().default(""),
  FEISHU_VERIFICATION_TOKEN: z.string().default(""),
  FEISHU_ENCRYPT_KEY: z.string().default(""),
  FEISHU_ALLOWED_OPEN_IDS: z.string().default(""),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  PORT: z.coerce.number().default(8787)
});

const env = schema.parse(process.env);

const defaultCursorChatInputSelector = '.tiptap.ProseMirror[contenteditable="true"], [class*="ai-input"] textarea, [class*="composer"] textarea, [class*="composer"] [role="textbox"]';
const defaultCursorResponseSelector = '.composer-rendered-message .anysphere-markdown-container-root, [class*="assistant-message"] [class*="markdown"], [class*="assistant"] [class*="markdown"]';
const defaultCursorModeSelector = '[class*="composer-unified-dropdown-model"]';
const defaultVscodeChatInputSelector = 'div[role="textbox"], textarea, [contenteditable="true"]';
const defaultVscodeResponseSelector = '[class*="markdown"], [role="document"], article';

function autoDetectSqlitePath(ideName: "Cursor" | "Windsurf" | "Code"): string {
  const appData = process.env.APPDATA;
  if (!appData) return "";
  const candidate = join(appData, ideName, "User", "globalStorage", "state.vscdb");
  return existsSync(candidate) ? candidate : "";
}

export const config = {
  env: env.NODE_ENV,
  telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  allowedTelegramUserIds: env.TELEGRAM_ALLOWED_USER_IDS
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0),
  bridgeBackendMode: env.BRIDGE_BACKEND_MODE,
  bridgeIdeTarget: env.BRIDGE_IDE_TARGET,
  bridgeApiAuthToken: env.BRIDGE_API_AUTH_TOKEN,
  cursorAppExe: env.CURSOR_APP_EXE,
  cursorRemoteDebugUrl: env.CURSOR_REMOTE_DEBUG_URL,
  cursorTargetTitleHint: env.CURSOR_TARGET_TITLE_HINT,
  cursorChatInputSelector: env.CURSOR_CHAT_INPUT_SELECTOR.trim() || defaultCursorChatInputSelector,
  cursorResponseSelector: env.CURSOR_RESPONSE_SELECTOR.trim() || defaultCursorResponseSelector,
  cursorContextSelector: env.CURSOR_CONTEXT_SELECTOR,
  cursorModelSelector: env.CURSOR_MODEL_SELECTOR.trim() || defaultCursorModeSelector,
  cursorContextRegion: env.CURSOR_CONTEXT_REGION,
  cursorContextHoverPoint: env.CURSOR_CONTEXT_HOVER_POINT,
  cursorActionTimeoutMs: env.CURSOR_ACTION_TIMEOUT_MS,
  telegramRequestTimeoutMs: env.TELEGRAM_REQUEST_TIMEOUT_MS,
  cursorSqlitePath: env.CURSOR_SQLITE_PATH || autoDetectSqlitePath("Cursor"),
  windsurfRemoteDebugUrl: env.WINDSURF_REMOTE_DEBUG_URL,
  windsurfTargetTitleHint: env.WINDSURF_TARGET_TITLE_HINT,
  windsurfChatInputSelector: env.WINDSURF_CHAT_INPUT_SELECTOR || 'div[role="textbox"]',
  windsurfResponseSelector: env.WINDSURF_RESPONSE_SELECTOR || '[class*="prose"]',
  windsurfModeSelector: env.WINDSURF_MODE_SELECTOR || 'button',
  windsurfContextSelector: env.WINDSURF_CONTEXT_SELECTOR,
  windsurfModelSelector: env.WINDSURF_MODEL_SELECTOR,
  windsurfActionTimeoutMs: env.WINDSURF_ACTION_TIMEOUT_MS,
  windsurfSqlitePath: env.WINDSURF_SQLITE_PATH || autoDetectSqlitePath("Windsurf"),
  vscodeRemoteDebugUrl: env.VSCODE_REMOTE_DEBUG_URL,
  vscodeTargetTitleHint: env.VSCODE_TARGET_TITLE_HINT,
  vscodeChatInputSelector: env.VSCODE_CHAT_INPUT_SELECTOR.trim() || defaultVscodeChatInputSelector,
  vscodeResponseSelector: env.VSCODE_RESPONSE_SELECTOR.trim() || defaultVscodeResponseSelector,
  vscodeModeSelector: env.VSCODE_MODE_SELECTOR,
  vscodeModelSelector: env.VSCODE_MODEL_SELECTOR,
  vscodeContextSelector: env.VSCODE_CONTEXT_SELECTOR,
  vscodeActionTimeoutMs: env.VSCODE_ACTION_TIMEOUT_MS,
  vscodeSqlitePath: env.VSCODE_SQLITE_PATH || autoDetectSqlitePath("Code"),
  cursorApi: {
    key: env.CURSOR_API_KEY,
    baseUrl: env.CURSOR_API_BASE_URL,
    repository: env.CURSOR_API_REPOSITORY,
    model: env.CURSOR_API_MODEL,
    ref: env.CURSOR_API_REF,
    timeoutMs: env.CURSOR_API_TIMEOUT_MS
  },
  discord: {
    enabled: env.DISCORD_ENABLED.toLowerCase() === "true",
    token: env.DISCORD_BOT_TOKEN,
    allowedUserIds: env.DISCORD_ALLOWED_USER_IDS
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  },
  email: {
    enabled: env.EMAIL_ENABLED.toLowerCase() === "true",
    allowedFrom: env.EMAIL_ALLOWED_FROM
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length > 0),
    imap: {
      host: env.EMAIL_IMAP_HOST,
      port: env.EMAIL_IMAP_PORT,
      secure: env.EMAIL_IMAP_SECURE.toLowerCase() === "true",
      user: env.EMAIL_IMAP_USER,
      pass: env.EMAIL_IMAP_PASS
    },
    smtp: {
      host: env.EMAIL_SMTP_HOST,
      port: env.EMAIL_SMTP_PORT,
      secure: env.EMAIL_SMTP_SECURE.toLowerCase() === "true",
      user: env.EMAIL_SMTP_USER,
      pass: env.EMAIL_SMTP_PASS
    },
    pollIntervalMs: env.EMAIL_POLL_INTERVAL_MS
  },
  feishu: {
    enabled: env.FEISHU_ENABLED.toLowerCase() === "true",
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    verificationToken: env.FEISHU_VERIFICATION_TOKEN,
    encryptKey: env.FEISHU_ENCRYPT_KEY,
    allowedOpenIds: env.FEISHU_ALLOWED_OPEN_IDS
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  },
  logLevel: env.LOG_LEVEL,
  port: env.PORT
};
