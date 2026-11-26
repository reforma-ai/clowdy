import { dlopen } from 'bun:ffi';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SLEEP_MODE, SLEEP_MODES, type SleepMode } from '@clowdy/protocol';
import { z } from 'zod';

import type { PowerSettings } from '@clowdy/protocol';

export interface SleepBlocker {
    setAwake(awake: boolean): void;
}

/** Native idle-sleep assertion owned by the daemon, not by any window or renderer. */
export function systemSleepBlocker(): SleepBlocker {
    if (process.platform === 'darwin') {
        let child: ReturnType<typeof Bun.spawn> | undefined;

        return {
            setAwake(awake) {
                if (!awake) {
                    child?.kill();
                    child = undefined;
                } else if (!child || child.exitCode !== null) {
                    // -i leaves the display alone; -w drops the assertion even if the daemon dies unexpectedly.
                    child = Bun.spawn(['/usr/bin/caffeinate', '-i', '-w', String(process.pid)], {
                        stdin: 'ignore',
                        stdout: 'ignore',
                        stderr: 'ignore',
                    });
                    child.unref();
                }
            },
        };
    }

    if (process.platform === 'win32') {
        let library: ReturnType<typeof openKernel> | undefined;
        let held = false;

        return {
            setAwake(awake) {
                if (awake === held) return;
                library ??= openKernel();
                // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, or ES_CONTINUOUS alone to clear the request.
                if (!library.symbols.SetThreadExecutionState(awake ? 0x80000001 : 0x80000000)) {
                    throw new Error('Windows refused the idle sleep assertion');
                }
                held = awake;
            },
        };
    }

    return { setAwake() {} };
}

function openKernel() {
    return dlopen('kernel32.dll', { SetThreadExecutionState: { args: ['u32'], returns: 'u32' } });
}

const settingsSchema = z.object({ sleepMode: z.enum(SLEEP_MODES) });

/** Global, persisted on the machine that runs the agents. */
export class PowerService {
    private readonly file: string;
    private mode: SleepMode = DEFAULT_SLEEP_MODE;
    private timer: ReturnType<typeof setInterval> | undefined;
    private lastError: string | undefined;

    constructor(
        dataDir: string,
        private readonly active: () => boolean,
        private readonly blocker: SleepBlocker
    ) {
        this.file = join(dataDir, 'power.json');
        if (existsSync(this.file)) {
            try {
                this.mode = settingsSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))).sleepMode;
            } catch (error) {
                console.error('[clowdy] Could not read power settings:', error);
            }
        }
    }

    get settings(): PowerSettings {
        return { sleepMode: this.mode };
    }

    setMode(mode: SleepMode): PowerSettings {
        if (mode !== this.mode) {
            const temp = `${this.file}.tmp`;
            writeFileSync(temp, `${JSON.stringify({ sleepMode: mode })}\n`);
            renameSync(temp, this.file);
            this.mode = mode;
        }
        this.refresh();

        return this.settings;
    }

    start(): void {
        // Also recover an assertion if the OS helper exits unexpectedly.
        this.timer ??= setInterval(() => this.refresh(), 5000);
        this.timer.unref();
        this.refresh();
    }

    refresh(): void {
        // A settings request already in flight can finish after daemon shutdown begins.
        // Save the preference for next startup, but never acquire another assertion while stopped.
        if (this.timer === undefined) return;

        try {
            this.blocker.setAwake(this.mode === 'always' || (this.mode === 'while-working' && this.active()));
            this.lastError = undefined;
        } catch (error) {
            const message = String(error);
            if (message !== this.lastError) console.error('[clowdy] Could not update idle sleep assertion:', error);
            this.lastError = message;
        }
    }

    stop(): void {
        clearInterval(this.timer);
        this.timer = undefined;
        try {
            this.blocker.setAwake(false);
        } catch (error) {
            console.error('[clowdy] Could not release idle sleep assertion:', error);
        }
    }
}
