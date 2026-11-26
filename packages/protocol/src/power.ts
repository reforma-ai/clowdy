/** Idle system sleep, independent of the display's sleep timer. */
export const SLEEP_MODES = ['allow', 'while-working', 'always'] as const;
export type SleepMode = (typeof SLEEP_MODES)[number];
export const DEFAULT_SLEEP_MODE: SleepMode = 'while-working';

export interface PowerSettings {
    sleepMode: SleepMode;
}
