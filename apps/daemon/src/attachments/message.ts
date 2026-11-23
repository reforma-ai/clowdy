/** `214 KB`, `3 KB`, `1.5 MB`: whole numbers from ten up, one decimal below, bytes under a kilobyte. */
export function formatSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    const units = ['KB', 'MB', 'GB'];
    const round = (value: number) => (value >= 10 ? Math.round(value) : Math.round(value * 10) / 10);
    let value = bytes / 1024;
    let unit = 0;

    // 1,048,000 bytes is 1023.4 KB, which rounds to 1023 KB; 1,048,500 would show 1024 KB, so it moves up a unit.
    while (round(value) >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }

    return `${round(value)} ${units[unit]}`;
}

/** A path the way a message mentions a file: `@src/a.ts`, and `@"my notes.md"` when it holds whitespace (as the composer writes it). */
const pathMention = (path: string) => (/\s/.test(path) ? `@"${path}"` : `@${path}`);

export interface AgentFile {
    path: string;
    mediaType: string;
    size: number;
}

/**
 * What an agent reads of a message with files: the person's text, then after a blank line a list of the files with where they are.
 * With no text it is the list alone. The agent sees plain text only; the chat shows the person's own words and the files as cards.
 */
export function messageWithFiles(text: string, files: AgentFile[]): string {
    if (files.length === 0) {
        return text;
    }

    const block = [
        'Attached files:',
        ...files.map(file => `- ${pathMention(file.path)} (${file.mediaType}, ${formatSize(file.size)})`),
    ].join('\n');

    return text ? `${text}\n\n${block}` : block;
}
