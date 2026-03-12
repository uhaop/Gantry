import { BaseCdpClient } from "../cdp/BaseCdpClient";
import { config } from "../config";

export class VscodeCdpClient extends BaseCdpClient {
  constructor() {
    super({
      remoteDebugUrl: config.vscodeRemoteDebugUrl,
      targetTitleHint: config.vscodeTargetTitleHint
    });
  }
}
