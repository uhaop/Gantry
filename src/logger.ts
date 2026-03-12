import pino from "pino";
import { config } from "./config";

const baseOptions = {
  level: config.logLevel
};

const devOptions = config.env === "development"
  ? {
      ...baseOptions,
      transport: {
        target: "pino-pretty",
        options: { colorize: true }
      }
    }
  : baseOptions;

export const logger = pino(devOptions);
