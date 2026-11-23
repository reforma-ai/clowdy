/** A count that is not a number, or is below zero, counts as nothing. */
export const tokensOf = (count: number) => (Number.isFinite(count) ? Math.max(0, count) : 0);

/**
 * A token count as the context ring and the compaction line say it: plain under a thousand, then `92.3K` (one decimal, no trailing `.0`), then `1M`
 * or `1.2M`. The rounding carries over: 999,960 tokens read `1M`, never `1000K`.
 */
export function formatTokens(count: number): string {
    const tokens = Math.round(tokensOf(count));

    if (tokens < 1_000) return String(tokens);

    const thousands = Math.round(tokens / 100) / 10;

    if (thousands < 1_000) return `${thousands}K`;

    return `${Math.round(tokens / 100_000) / 10}M`;
}
