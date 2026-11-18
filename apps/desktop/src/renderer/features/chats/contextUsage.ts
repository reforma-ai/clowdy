import { usageTone, type UsageTone } from '../settings/providers/providerView';

import type { RunContext } from '@clowdy/protocol';

/** A count that is not a number, or is below zero, counts as nothing. */
const tokensOf = (count: number) => (Number.isFinite(count) ? Math.max(0, count) : 0);

/**
 * A token count as the context ring says it: plain under a thousand, then `92.3K` (one decimal, no trailing `.0`), then `1M` or `1.2M`.
 * The rounding carries over: 999,960 tokens read `1M`, never `1000K`.
 */
export function formatTokens(count: number): string {
    const tokens = Math.round(tokensOf(count));

    if (tokens < 1_000) return String(tokens);

    const thousands = Math.round(tokens / 100) / 10;

    if (thousands < 1_000) return `${ thousands }K`;

    return `${ Math.round(tokens / 100_000) / 10 }M`;
}

/** What the ring and its popover say of a reading. */
export interface ContextFill {
    /** How full the window is, as a whole percent between 0 and 100 (a window of no size is empty). */
    percent: number;
    /** The tone of the percent: the same thresholds as the usage bars of the Providers page. */
    tone: UsageTone;
    /** The tokens in the window, an estimate: `~92.3K`. */
    used: string;
    /** The size of the window: `200K`. */
    size: string;
    /** `46% full`. */
    label: string;
}

/** The ring's numbers from the orchestrator's latest `usage_update`. */
export function contextFill(context: RunContext): ContextFill {
    const used = tokensOf(context.used);
    const size = tokensOf(context.size);
    const percent = size > 0 ? Math.min(100, Math.round((used * 100) / size)) : 0;

    return {
        percent,
        tone: usageTone(percent),
        used: `~${ formatTokens(used) }`,
        size: formatTokens(size),
        label: `${ percent }% full`,
    };
}
