import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface StoredPrompt {
  prompt: string;
  at: number;
}

interface StoredDelivered {
  text: string;
  at: number;
  requestId?: number;
}

interface StoredHistoryEntry {
  text: string;
  at: number;
}

interface StoredChatState {
  lastPrompt?: StoredPrompt;
  lastDelivered?: StoredDelivered;
  history: StoredHistoryEntry[];
}

interface PersistedPayload {
  chats: Record<string, StoredChatState>;
  flags?: Record<string, boolean>;
}

export class ChatStateStore {
  private readonly filePath: string;
  private readonly chats = new Map<number, StoredChatState>();
  private readonly flags = new Map<string, boolean>();
  private loaded = false;

  constructor(filePath = join(process.cwd(), "tmp", "state", "chat-state.json")) {
    this.filePath = filePath;
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedPayload;
      const chatEntries = Object.entries(parsed.chats || {});
      for (const [chatIdRaw, state] of chatEntries) {
        const chatId = Number(chatIdRaw);
        if (!Number.isFinite(chatId)) {
          continue;
        }
        const loadedState: StoredChatState = {
          history: Array.isArray(state.history) ? state.history.slice(0, 20) : []
        };
        if (state.lastPrompt) {
          loadedState.lastPrompt = state.lastPrompt;
        }
        if (state.lastDelivered) {
          loadedState.lastDelivered = state.lastDelivered;
        }
        this.chats.set(chatId, loadedState);
      }

      if (parsed.flags && typeof parsed.flags === "object") {
        for (const [key, value] of Object.entries(parsed.flags)) {
          this.flags.set(key, Boolean(value));
        }
      }
    } catch {
      // Ignore load errors and start from empty state.
    }
  }

  private persist(): void {
    const payload: PersistedPayload = { chats: {}, flags: {} };
    for (const [chatId, state] of this.chats.entries()) {
      payload.chats[String(chatId)] = state;
    }
    for (const [key, value] of this.flags.entries()) {
      payload.flags![key] = value;
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(payload, null, 2), "utf8");
  }

  private getOrInit(chatId: number): StoredChatState {
    this.ensureLoaded();
    const existing = this.chats.get(chatId);
    if (existing) {
      return existing;
    }
    const created: StoredChatState = { history: [] };
    this.chats.set(chatId, created);
    return created;
  }

  recordPrompt(chatId: number, prompt: string, at = Date.now()): void {
    const state = this.getOrInit(chatId);
    state.lastPrompt = { prompt, at };
    this.persist();
  }

  recordDelivered(chatId: number, text: string, requestId?: number, at = Date.now()): void {
    const state = this.getOrInit(chatId);
    const delivered: StoredDelivered = { text, at };
    if (typeof requestId === "number") {
      delivered.requestId = requestId;
    }
    state.lastDelivered = delivered;
    state.history.unshift({ text, at });
    state.history = state.history.slice(0, 20);
    this.persist();
  }

  getLastPrompt(chatId: number): StoredPrompt | null {
    const state = this.getOrInit(chatId);
    return state.lastPrompt ?? null;
  }

  getLastDelivered(chatId: number): StoredDelivered | null {
    const state = this.getOrInit(chatId);
    return state.lastDelivered ?? null;
  }

  getHistory(chatId: number, limit = 5): StoredHistoryEntry[] {
    const state = this.getOrInit(chatId);
    return state.history.slice(0, Math.max(1, limit));
  }

  clearHistory(chatId: number): number {
    const state = this.getOrInit(chatId);
    const removed = state.history.length;
    state.history = [];
    this.persist();
    return removed;
  }

  clearChat(chatId: number): void {
    this.ensureLoaded();
    this.chats.delete(chatId);
    this.persist();
  }

  getFlag(key: string): boolean | null {
    this.ensureLoaded();
    return this.flags.has(key) ? Boolean(this.flags.get(key)) : null;
  }

  setFlag(key: string, value: boolean): void {
    this.ensureLoaded();
    this.flags.set(key, value);
    this.persist();
  }
}

