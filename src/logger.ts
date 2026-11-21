import pino, { type Logger } from 'pino';
import { getConfig } from './config';

export type { Logger };

export function createLogger(name: string): Logger {
  const config = getConfig();
  return pino({
    name,
    level: config.LOG_LEVEL,
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie'],
      remove: true,
    },
    ...(config.LOG_PRETTY
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
          },
        }
      : {}),
  });
}
