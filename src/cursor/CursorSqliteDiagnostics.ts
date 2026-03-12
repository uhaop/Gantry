import { existsSync } from "node:fs";
import { config } from "../config";

/**
 * Unsupported contract surface:
 * Cursor/Windsurf internal SQLite layout can change at any update.
 * This module is diagnostics-only and never gates core behavior.
 * Auto-detects the right SQLite path based on BRIDGE_IDE_TARGET.
 */
export class CursorSqliteDiagnostics {
  private get sqlitePath(): string {
    return config.bridgeIdeTarget === "windsurf"
      ? config.windsurfSqlitePath
      : config.cursorSqlitePath;
  }

  private get ideName(): string {
    return config.bridgeIdeTarget === "windsurf" ? "Windsurf" : "Cursor";
  }

  isConfigured(): boolean {
    const p = this.sqlitePath;
    return p.length > 0 && existsSync(p);
  }

  async probe(): Promise<string> {
    if (!this.isConfigured()) {
      const p = this.sqlitePath;
      if (!p) {
        return `${this.ideName} SQLite diagnostics unavailable (path not configured and auto-detect failed).`;
      }
      return `${this.ideName} SQLite diagnostics unavailable (file not found: ${p}).`;
    }
    return `${this.ideName} SQLite diagnostics configured (${this.sqlitePath}). Schema checks are intentionally non-contractual.`;
  }
}
