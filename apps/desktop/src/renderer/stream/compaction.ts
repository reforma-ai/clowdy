import { isRecord } from './toolView';

/** The name the daemon gives every agent's compaction call, Claude's and Codex's alike. */
export const COMPACT_TOOL = 'compact';

/** The tokens in the context before and after a compaction. */
export interface CompactionCounts {
    before: number;
    after: number;
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * What a compaction saved, from its call's output: Claude's adapter reports `{ trigger, preTokens, postTokens, durationMs }`, which reaches the stream as
 * an object or as that object in JSON text. Codex reports nothing, and neither does a call that failed.
 */
export function compactionCounts(output: unknown): CompactionCounts | undefined {
    let value = output;

    if (typeof output === 'string') {
        try {
            value = JSON.parse(output);
        } catch {
            return undefined;
        }
    }

    if (!isRecord(value) || !isCount(value.preTokens) || !isCount(value.postTokens)) return undefined;

    return { before: value.preTokens, after: value.postTokens };
}
