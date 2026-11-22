/** POSIX path helpers for provider-relative paths. The root is the empty string. */

/** Drops empty and `.` segments, resolves `..`, and strips leading and trailing slashes. */
export function normalizePath(path: string): string {
    const parts: string[] = [];

    for (const part of path.split('/')) {
        if (part === '' || part === '.') {
            continue;
        }

        if (part === '..') {
            parts.pop();

            continue;
        }

        parts.push(part);
    }

    return parts.join('/');
}

/** `app` + `ui/button.tsx` → `app/ui/button.tsx`; the root `''` adds nothing. */
export function joinPath(parent: string, name: string): string {
    return normalizePath(`${parent}/${name}`);
}

/** `app/page.tsx` → `app`; a top-level path → `''`. */
export function dirname(path: string): string {
    const slash = path.lastIndexOf('/');

    return slash === -1 ? '' : path.slice(0, slash);
}

/** `app/page.tsx` → `page.tsx`. */
export function basename(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

/** Lowercase extension without the dot: `page.TSX` → `tsx`; `.gitignore` → `''`. */
export function extname(path: string): string {
    const name = basename(path);
    const dot = name.lastIndexOf('.');

    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

const MEDIA_KINDS: Partial<Record<string, MediaKind>> = {
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    gif: 'image',
    webp: 'image',
    avif: 'image',
    bmp: 'image',
    ico: 'image',
    mp4: 'video',
    webm: 'video',
    mov: 'video',
    m4v: 'video',
    ogv: 'video',
    mp3: 'audio',
    wav: 'audio',
    ogg: 'audio',
    oga: 'audio',
    m4a: 'audio',
    aac: 'audio',
    flac: 'audio',
    opus: 'audio',
    pdf: 'pdf',
};

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf';

/** The media a browser can preview for this file name, by extension. */
export function mediaKind(path: string): MediaKind | undefined {
    return MEDIA_KINDS[extname(path)];
}

/** Markdown the rich text editor opens: `.md` and `.markdown`, not `.mdx`. */
export function isRichMarkdown(path: string): boolean {
    const extension = extname(path);

    return extension === 'md' || extension === 'markdown';
}

/** True when `path` is `ancestor` or inside it. */
export function isPathWithin(path: string, ancestor: string): boolean {
    return ancestor === '' || path === ancestor || path.startsWith(`${ancestor}/`);
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Text of UTF-8 `bytes`, or `null` when they are not valid UTF-8. A BOM is kept, so the text round-trips. */
export function decodeUtf8(bytes: Uint8Array): string | null {
    try {
        return strictUtf8.decode(bytes);
    }
    catch {
        return null;
    }
}
