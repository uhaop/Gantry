import {
  Client,
  GatewayIntentBits,
  Partials
} from "discord.js";
import { config } from "../config";
import { logger } from "../logger";
import { CommandRouter } from "./CommandRouter";

export class DiscordService {
  private readonly router = new CommandRouter();
  private readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });

  start(): void {
    if (!config.discord.enabled) {
      logger.info("Discord adapter disabled");
      return;
    }
    if (!config.discord.token) {
      logger.warn("Discord adapter enabled but DISCORD_BOT_TOKEN is missing");
      return;
    }

    this.client.on("ready", () => {
      logger.info({ user: this.client.user?.tag }, "Discord adapter ready");
    });

    this.client.on("messageCreate", async (message) => {
      if (message.author.bot) {
        return;
      }
      if (config.discord.allowedUserIds.length > 0 && !config.discord.allowedUserIds.includes(message.author.id)) {
        return;
      }
      const text = message.content?.trim();
      if (!text) {
        return;
      }
      try {
        const reply = await this.router.handle(`discord:${message.channelId}`, text);
        await message.reply(reply);
      } catch (error) {
        logger.warn({ error }, "Discord message handling failed");
        await message.reply("Request failed. Check bridge logs for details.");
      }
    });

    this.client.login(config.discord.token).catch((error) => {
      logger.error({ error }, "Discord adapter login failed");
    });
  }
}

