import pino from "pino";

const pretty = process.env.LOG_PRETTY === "true";

export const logger = pino(
  pretty
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
        },
      }
    : {}
);
