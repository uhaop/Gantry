import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { config } from "../config";
import { logger } from "../logger";
import { CommandRouter } from "./CommandRouter";

export class EmailService {
  private readonly router = new CommandRouter();
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (!config.email.enabled) {
      logger.info("Email adapter disabled");
      return;
    }
    if (!config.email.imap.host || !config.email.imap.user || !config.email.imap.pass) {
      logger.warn("Email adapter enabled but IMAP settings are incomplete");
      return;
    }
    if (!config.email.smtp.host || !config.email.smtp.user || !config.email.smtp.pass) {
      logger.warn("Email adapter enabled but SMTP settings are incomplete");
      return;
    }
    this.timer = setInterval(() => {
      this.poll().catch((error) => {
        logger.warn({ error }, "Email adapter poll failed");
      });
    }, Math.max(10000, config.email.pollIntervalMs));
    this.poll().catch((error) => {
      logger.warn({ error }, "Email adapter initial poll failed");
    });
    logger.info({ intervalMs: config.email.pollIntervalMs }, "Email adapter started");
  }

  private isAllowed(fromAddress: string): boolean {
    if (config.email.allowedFrom.length === 0) {
      return true;
    }
    return config.email.allowedFrom.includes(fromAddress.toLowerCase());
  }

  private async poll(): Promise<void> {
    const client = new ImapFlow({
      host: config.email.imap.host,
      port: config.email.imap.port,
      secure: config.email.imap.secure,
      auth: {
        user: config.email.imap.user,
        pass: config.email.imap.pass
      }
    });
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const searchResult = await client.search({ seen: false });
        const messages = Array.isArray(searchResult) ? searchResult : [];
        for (const seq of messages) {
          const fetched = await client.fetchOne(seq, { source: true, envelope: true, uid: true });
          if (!fetched || !fetched.source) {
            continue;
          }
          const parsed = await simpleParser(fetched.source);
          const from = parsed.from?.value?.[0]?.address?.toLowerCase();
          if (!from) {
            continue;
          }
          if (!this.isAllowed(from)) {
            await client.messageFlagsAdd(seq, ["\\Seen"]);
            continue;
          }
          const body = (parsed.text || "").trim();
          if (!body) {
            await client.messageFlagsAdd(seq, ["\\Seen"]);
            continue;
          }
          const firstLine = body
            .split("\n")
            .map((line: string) => line.trim())
            .find((line: string) => line.length > 0) ?? "";
          if (!firstLine) {
            await client.messageFlagsAdd(seq, ["\\Seen"]);
            continue;
          }
          const reply = await this.router.handle(`email:${from}`, firstLine);
          await this.sendReply(from, parsed.subject ?? "Bridge request", reply);
          await client.messageFlagsAdd(seq, ["\\Seen"]);
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  private async sendReply(to: string, subject: string, text: string): Promise<void> {
    const transporter = nodemailer.createTransport({
      host: config.email.smtp.host,
      port: config.email.smtp.port,
      secure: config.email.smtp.secure,
      auth: {
        user: config.email.smtp.user,
        pass: config.email.smtp.pass
      }
    });
    await transporter.sendMail({
      from: config.email.smtp.user,
      to,
      subject: `Re: ${subject}`,
      text
    });
  }
}

