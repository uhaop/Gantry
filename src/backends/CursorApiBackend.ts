import { config } from "../config";
import { BridgeMode } from "../types";

interface ApiResponse {
  text: string;
}

export class CursorApiBackend {
  private activeAgentId: string | null = null;
  private mode: BridgeMode = "ask";

  private ensureConfigured(): string | null {
    if (!config.cursorApi.key) {
      return "API backend not configured: CURSOR_API_KEY is missing.";
    }
    if (!config.cursorApi.repository) {
      return "API backend not configured: CURSOR_API_REPOSITORY is missing.";
    }
    return null;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.cursorApi.timeoutMs);
    try {
      const response = await fetch(`${config.cursorApi.baseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${config.cursorApi.key}`,
          ...(init?.headers ?? {})
        },
        signal: controller.signal
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Cursor API ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`);
      }
      if (response.status === 204) {
        return {} as T;
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private firstString(value: unknown): string | null {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.firstString(item);
        if (found) return found;
      }
      return null;
    }
    if (value && typeof value === "object") {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        const found = this.firstString(nested);
        if (found) return found;
      }
    }
    return null;
  }

  async switchMode(mode: BridgeMode): Promise<ApiResponse> {
    this.mode = mode;
    return { text: `Mode set to ${mode} (API backend best-effort).` };
  }

  async newChat(): Promise<ApiResponse> {
    this.activeAgentId = null;
    return { text: "Started a new API-backed chat session." };
  }

  async relayPrompt(prompt: string): Promise<ApiResponse> {
    const configError = this.ensureConfigured();
    if (configError) {
      return { text: configError };
    }

    if (!this.activeAgentId) {
      const created = await this.request<{ id?: string; agent_id?: string }>("/v0/agents", {
        method: "POST",
        body: JSON.stringify({
          prompt: { text: prompt },
          ...(config.cursorApi.model ? { model: config.cursorApi.model } : {}),
          source: {
            repository: config.cursorApi.repository,
            ...(config.cursorApi.ref ? { ref: config.cursorApi.ref } : {})
          }
        })
      });
      this.activeAgentId = created.id ?? created.agent_id ?? null;
      if (!this.activeAgentId) {
        return { text: "API backend created task but did not return an agent id." };
      }
      return { text: `API task started (${this.activeAgentId}). Use /last for latest assistant output.` };
    }

    await this.request(`/v0/agents/${encodeURIComponent(this.activeAgentId)}/followup`, {
      method: "POST",
      body: JSON.stringify({ prompt: { text: prompt } })
    });
    return { text: `API follow-up submitted to ${this.activeAgentId}.` };
  }

  async latestResponse(): Promise<string | null> {
    if (!this.activeAgentId) {
      return null;
    }
    try {
      const conversation = await this.request<unknown>(`/v0/agents/${encodeURIComponent(this.activeAgentId)}/conversation`);
      return this.firstString(conversation);
    } catch {
      return null;
    }
  }

  async diagnostics(): Promise<string> {
    return [
      "API backend diagnostics",
      `- configured: ${this.ensureConfigured() ? "no" : "yes"}`,
      `- mode: ${this.mode}`,
      `- activeAgentId: ${this.activeAgentId ?? "none"}`,
      `- baseUrl: ${config.cursorApi.baseUrl}`,
      `- repository: ${config.cursorApi.repository || "unset"}`
    ].join("\n");
  }
}

