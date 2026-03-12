export type BridgeMode = "ask" | "code" | "plan" | "debug";

export type SupportStatus = "official" | "best-effort" | "unsupported-contract";

export interface ContextReading {
  percent: number | null;
  confidence: number;
  source: "dom" | "hover-ocr" | "unavailable";
  note?: string;
}

export interface BridgeResponse {
  text: string;
  metadata?: Record<string, string | number | boolean | null>;
}
