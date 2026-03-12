import { createHmac } from "node:crypto";
import { config } from "../config";
import { logger } from "../logger";
import { CommandRouter } from "./CommandRouter";

interface FeishuEventPayload {
  challenge?: string;
  type?: string;
  header?: {
    event_type?: string;
    token?: string;
  };
  event?: {
    sender?: {
      sender_id?: {
        open_id?: string;
      };
    };
    message?: {
      message_type?: string;
      content?: string;
    };
  };
}

export class FeishuService {
  private readonly router = new CommandRouter();
  private tenantToken: { value: string; expiresAt: number } | null = null;

  enabled(): boolean {
    return config.feishu.enabled;
  }

  async handleEvents(rawBody: string, headers: Record<string, string | undefined>): Promise<{ status: number; body: unknown }> {
    if (!this.enabled()) {
      return { status: 404, body: { ok: false, error: "Feishu adapter disabled" } };
    }
    if (config.feishu.encryptKey) {
      const ts = headers["x-lark-request-timestamp"] ?? headers["x-lark-request-timestamp".toLowerCase()];
      const nonce = headers["x-lark-request-nonce"] ?? headers["x-lark-request-nonce".toLowerCase()];
      const signature = headers["x-lark-signature"] ?? headers["x-lark-signature".toLowerCase()];
      if (!ts || !nonce || !signature || !this.verifySignature(ts, nonce, signature)) {
        return { status: 401, body: { ok: false, error: "invalid feishu signature" } };
      }
    }

    let payload: FeishuEventPayload;
    try {
      payload = JSON.parse(rawBody) as FeishuEventPayload;
    } catch {
      return { status: 400, body: { ok: false, error: "invalid json" } };
    }

    if (payload.challenge) {
      return { status: 200, body: { challenge: payload.challenge } };
    }

    if (config.feishu.verificationToken && payload.header?.token && payload.header.token !== config.feishu.verificationToken) {
      return { status: 401, body: { ok: false, error: "invalid verification token" } };
    }

    if (payload.header?.event_type !== "im.message.receive_v1") {
      return { status: 200, body: { ok: true, ignored: true } };
    }

    const openId = payload.event?.sender?.sender_id?.open_id;
    if (!openId) {
      return { status: 200, body: { ok: true, ignored: true } };
    }
    if (config.feishu.allowedOpenIds.length > 0 && !config.feishu.allowedOpenIds.includes(openId)) {
      return { status: 200, body: { ok: true, ignored: true } };
    }

    const contentRaw = payload.event?.message?.content ?? "";
    const text = this.extractTextFromContent(contentRaw);
    if (!text) {
      return { status: 200, body: { ok: true, ignored: true } };
    }

    try {
      const reply = await this.router.handle(`feishu:${openId}`, text);
      await this.sendText(openId, reply);
      return { status: 200, body: { ok: true } };
    } catch (error) {
      logger.warn({ error }, "Feishu event handling failed");
      return { status: 500, body: { ok: false, error: "processing failed" } };
    }
  }

  private verifySignature(timestamp: string, nonce: string, signature: string): boolean {
    const base = `${timestamp}${nonce}${config.feishu.encryptKey}`;
    const expected = createHmac("sha256", config.feishu.encryptKey).update(base).digest("base64");
    return expected === signature;
  }

  private extractTextFromContent(raw: string): string {
    try {
      const parsed = JSON.parse(raw) as { text?: string };
      return (parsed.text ?? "").trim();
    } catch {
      return "";
    }
  }

  private async getTenantAccessToken(): Promise<string> {
    if (this.tenantToken && this.tenantToken.expiresAt > Date.now() + 60_000) {
      return this.tenantToken.value;
    }
    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app_id: config.feishu.appId,
        app_secret: config.feishu.appSecret
      })
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Feishu token request failed: ${response.status} ${text}`);
    }
    const data = (await response.json()) as { tenant_access_token?: string; expire?: number };
    if (!data.tenant_access_token) {
      throw new Error("Feishu token missing tenant_access_token");
    }
    const ttl = (data.expire ?? 3600) * 1000;
    this.tenantToken = {
      value: data.tenant_access_token,
      expiresAt: Date.now() + ttl
    };
    return this.tenantToken.value;
  }

  private async sendText(openId: string, text: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        receive_id: openId,
        msg_type: "text",
        content: JSON.stringify({ text })
      })
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Feishu send failed: ${response.status} ${body}`);
    }
  }
}

