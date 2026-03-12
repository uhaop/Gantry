import { createServer, IncomingMessage } from "node:http";
import { config } from "../config";
import { logger } from "../logger";
import { CommandRouter } from "../platform/CommandRouter";
import { FeishuService } from "../platform/FeishuService";

const router = new CommandRouter();
const feishu = new FeishuService();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function unauthorized(res: { statusCode: number; setHeader: (name: string, value: string) => void; end: (value: string) => void }): void {
  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "unauthorized" }));
}

export function startHealthServer(): void {
  const server = createServer(async (req, res) => {
    const method = req.method || "GET";
    const url = req.url || "/";

    if (method === "GET" && url === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, service: "gantry", backend: config.bridgeBackendMode }));
      return;
    }

    if (method === "POST" && url === "/v1/chat/completions") {
      if (config.bridgeApiAuthToken) {
        const auth = req.headers.authorization || "";
        if (auth !== `Bearer ${config.bridgeApiAuthToken}`) {
          unauthorized(res);
          return;
        }
      }
      const raw = await readBody(req);
      let body: {
        messages?: Array<{ role?: string; content?: string }>;
        model?: string;
      };
      try {
        body = JSON.parse(raw) as {
          messages?: Array<{ role?: string; content?: string }>;
          model?: string;
        };
      } catch {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "invalid json" }));
        return;
      }
      const message = [...(body.messages ?? [])].reverse().find((item) => item.role === "user" && item.content)?.content;
      if (!message) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "missing user message" }));
        return;
      }
      const answer = await router.handle("http:default", message);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model || "gantry",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: answer }
            }
          ]
        })
      );
      return;
    }

    if (method === "POST" && url === "/platform/feishu/events") {
      const raw = await readBody(req);
      const headerMap: Record<string, string | undefined> = {
        "x-lark-request-timestamp": req.headers["x-lark-request-timestamp"]?.toString(),
        "x-lark-request-nonce": req.headers["x-lark-request-nonce"]?.toString(),
        "x-lark-signature": req.headers["x-lark-signature"]?.toString()
      };
      const result = await feishu.handleEvents(raw, headerMap);
      res.statusCode = result.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result.body));
      return;
    }

    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });

  server.listen(config.port, () => {
    logger.info({ port: config.port }, "Health/API endpoint started");
  });
}
