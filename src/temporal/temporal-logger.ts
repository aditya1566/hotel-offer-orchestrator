import type { LogLevel, LogMetadata, Logger as TemporalLogger } from '@temporalio/common';
import type { Logger } from 'pino';

/**
 * Routes Temporal SDK logs (worker, workflow `log`, activity `log`) into pino so
 * that API and worker logs share one structured JSON format.
 */
export class PinoTemporalLogger implements TemporalLogger {
  constructor(private readonly logger: Logger) {}

  log(level: LogLevel, message: string, meta?: LogMetadata): void {
    // Drop the opaque, very long task token Temporal attaches to activity logs.
    const { taskToken: _taskToken, ...fields } = meta ?? {};
    switch (level) {
      case 'TRACE':
        return this.logger.trace(fields, message);
      case 'DEBUG':
        return this.logger.debug(fields, message);
      case 'WARN':
        return this.logger.warn(fields, message);
      case 'ERROR':
        return this.logger.error(fields, message);
      default:
        return this.logger.info(fields, message);
    }
  }

  trace(message: string, meta?: LogMetadata): void {
    this.log('TRACE', message, meta);
  }
  debug(message: string, meta?: LogMetadata): void {
    this.log('DEBUG', message, meta);
  }
  info(message: string, meta?: LogMetadata): void {
    this.log('INFO', message, meta);
  }
  warn(message: string, meta?: LogMetadata): void {
    this.log('WARN', message, meta);
  }
  error(message: string, meta?: LogMetadata): void {
    this.log('ERROR', message, meta);
  }
}
