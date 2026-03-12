import { BaseCdpClient } from "../cdp/BaseCdpClient";
import { config } from "../config";

export class WindsurfCdpClient extends BaseCdpClient {
  constructor() {
    super({
      remoteDebugUrl: config.windsurfRemoteDebugUrl,
      targetTitleHint: config.windsurfTargetTitleHint
    });
  }
}
