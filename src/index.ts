import { startHealthServer } from "./health/HealthServer";
import { TelegramBotService } from "./telegram/TelegramBotService";
import { config } from "./config";
import { logger } from "./logger";
import { DiscordService } from "./platform/DiscordService";
import { EmailService } from "./platform/EmailService";
import { runStartupPreflightCheck } from "./cdp/CdpPreflightCheck";

async function main(): Promise<void> {
  const bot = new TelegramBotService();
  const discord = new DiscordService();
  const email = new EmailService();
  bot.start();
  discord.start();
  email.start();
  startHealthServer();
  const ideName = config.bridgeIdeTarget === "windsurf" ? "Windsurf" : "Cursor";
  logger.info(`${ideName} multi-platform bridge started (target=${config.bridgeIdeTarget}, port=${config.port})`);

  // Non-blocking CDP preflight: validates connectivity + selectors, notifies users of issues
  runStartupPreflightCheck((msg) => bot.notifyAllUsers(msg)).catch(() => {});
}

main().catch((error) => {
  logger.error({ error }, "Fatal startup error");
  process.exit(1);
});
