export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Get log level from environment variables with fallbacks
const logLevel: LogLevel = (() => {
    // Check process.env.LOG_LEVEL first
    if (typeof process !== 'undefined' && process.env?.LOG_LEVEL) {
        const envLevel = process.env.LOG_LEVEL.toLowerCase();

        if (['debug', 'info', 'warn', 'error'].includes(envLevel)) {
            return envLevel as LogLevel;
        }
    }

    // Fallback to NODE_ENV-based levels
    switch (process.env.NODE_ENV) {
        case 'development':
            return 'debug';
        case 'test':
            return 'warn';
        case 'production':
            return 'error';

        default:
            return 'info';
    }
})();

export interface Logger {
    debug: (...args: any[]) => void;
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
}

/**
 * Create a simple logger with a name prefix
 */
export function createLogger(name: string): Logger {
    const prefix = `[${name}]`;

    return {
        debug: (...args: any[]) => {
            if (['debug'].includes(logLevel)) {
                console.debug(prefix, ...args);
            }
        },
        info: (...args: any[]) => {
            if (['debug', 'info'].includes(logLevel)) {
                console.info(prefix, ...args);
            }
        },
        warn: (...args: any[]) => {
            if (['debug', 'info', 'warn'].includes(logLevel)) {
                console.warn(prefix, ...args);
            }
        },
        error: (...args: any[]) => {
            // Always log errors regardless of log level

            console.error(prefix, ...args);
        },
    };
}

// Default logger instance
export const logger = createLogger('App');
