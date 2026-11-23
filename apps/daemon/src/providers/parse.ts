/** What a vendor's program printed, read the way more than one provider needs. */

/** A non-empty string, trimmed; anything else is `undefined`. */
export const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** The plan as a badge: `max` is `Max`, `team` is `Team`. */
export function planLabel(plan: string | null | undefined): string | undefined {
    if (!plan) {
        return undefined;
    }

    return plan
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map(word => word[0]!.toUpperCase() + word.slice(1))
        .join(' ');
}

/** The first JSON object in a program's output, which may have a line or two around it. */
export function jsonObject(text: string): Record<string, unknown> | undefined {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');

    if (start < 0 || end < start) {
        return undefined;
    }

    try {
        const value: unknown = JSON.parse(text.slice(start, end + 1));

        return value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}
