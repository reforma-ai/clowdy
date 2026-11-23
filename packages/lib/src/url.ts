/**
 * Absolute `http:` / `https:` URL (rejects relative paths, other schemes, junk).
 */
export function isHttpUrl(value: string): boolean {
    try {
        const parsed = new URL(value);

        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}
