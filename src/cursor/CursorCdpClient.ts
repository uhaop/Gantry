import { BaseCdpClient, ClientDomains, CdpTargetSummary } from "../cdp/BaseCdpClient";
import { config } from "../config";

export type { ClientDomains, CdpTargetSummary as CursorTargetSummary };
export { wait } from "../cdp/BaseCdpClient";

export class CursorCdpClient extends BaseCdpClient {
  constructor() {
    super({
      remoteDebugUrl: config.cursorRemoteDebugUrl,
      targetTitleHint: config.cursorTargetTitleHint
    });
  }
}
