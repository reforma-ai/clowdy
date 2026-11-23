/**
 * Browser-safe path helpers (no Node `path` module).
 * Handles both `/` and `\` separators.
 */

import {
    AUDIO_EXTENSIONS,
    CODE_EXTENSIONS,
    DOCUMENT_EXTENSIONS,
    EXTENSION_TO_SHIKI_LANGUAGE,
    IMAGE_EXTENSIONS,
    PAGE_EXTENSIONS,
    VIDEO_EXTENSIONS,
} from '@clowdy/constants';
import escapeRegExp from 'lodash/escapeRegExp';

export const pathSep = /[/\\]/;

/** Extensions we treat as real files (chips, citations) — not just Shiki grammars. */
const KNOWN_FILE_EXTENSIONS = new Set<string>([
    ...IMAGE_EXTENSIONS,
    ...AUDIO_EXTENSIONS,
    ...VIDEO_EXTENSIONS,
    ...PAGE_EXTENSIONS,
    ...DOCUMENT_EXTENSIONS,
    ...CODE_EXTENSIONS,
    ...Object.keys(EXTENSION_TO_SHIKI_LANGUAGE),
]);

/**
 * Get the basename of a path.
 * Example: `basename('src/components/')` → `components`.
 * Example: `basename('src/components/Button.tsx')` → `Button.tsx`.
 * Example: `basename('src/components/Button.tsx', 'tsx')` → `Button`.
 * @param filePath - The path to get the basename of.
 * @param ext - The extension to keep in the basename.
 * @returns The basename of the path.
 */
export function basename(filePath: string, ext?: string): string {
    const name = filePath.replace(/\/$/, '').replace(/^.*[/\\]/, '');

    if (ext != null && name.endsWith(ext)) {
        return name.slice(0, -ext.length);
    }

    return name;
}

export function extname(filePath: string): string {
    const m = filePath.match(/\.[^.]+$/);

    return m ? m[0] : '';
}

export function dirname(filePath: string): string {
    const d = filePath.replace(/[/\\][^/\\]*$/, '');

    return d || '.';
}

export function splitPath(filePath: string): string[] {
    return filePath.split(pathSep).filter(Boolean);
}

/**
 * Replace the home folder with `~` wherever a path in `text` starts with it, with either separator.
 * A name character on either side means another folder (`/var/root`, `/Users/anna`) and stays.
 * A blank home or a filesystem root leaves `text` as is: it would rewrite every path.
 */
export function replaceHomeDir(text: string, home: string): string {
    const root = home.trim().replace(/[/\\]+$/, '');

    if (!root || /^[a-z]:$/i.test(root)) {
        return text;
    }

    const pattern = root.split(pathSep).map(escapeRegExp).join('[/\\\\]');

    return text.replace(new RegExp(`(?<![\\w.-])${pattern}(?![\\w.-])`, 'g'), '~');
}

/** Join `fromFile`'s directory with a relative specifier (`./x`, `../y`). */
export function resolveRelativeImport(fromFile: string, specifier: string): string {
    const fromDir = dirname(fromFile);
    const parts = [...splitPath(fromDir === '.' ? '' : fromDir), ...splitPath(specifier)];
    const out: string[] = [];

    for (const part of parts) {
        if (part === '.' || part === '') {
            continue;
        }

        if (part === '..') {
            out.pop();

            continue;
        }

        out.push(part);
    }

    return out.join('/');
}

/**
 * Import specifier → workspace-relative module path (no extension probing).
 * - `./x` / `../x` — relative to `fromFile`
 * - `@/x` / `~/x` — project root (Clowdy/Next `@/*` → `./*`; `~/` same for imports)
 * - `/x` — strip leading slashes
 * - otherwise — as-is (e.g. already workspace-relative LOCAL sources)
 */
export function resolveImportSpecifier(fromFile: string, specifier: string): string {
    if (specifier.startsWith('.')) {
        return resolveRelativeImport(fromFile, specifier);
    }

    if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
        return specifier.slice(2);
    }

    return specifier.replace(/^\/+/, '');
}

/**
 * Last dotted suffix of a URL or path (lowercase, no dot). Query and hash are ignored.
 * Uses `URL` when the string parses as an absolute http(s)/file/blob/data URL; otherwise
 * treats the input as a path. Strips a trailing editor cursor (`:line` / `:line:col` /
 * `:line:col-line:col`) so labels like `page.tsx:14` still resolve to `tsx`.
 */
export function extractExtension(url: string | undefined): string | undefined {
    if (!url) {
        return undefined;
    }

    const pathOnly = (() => {
        try {
            const parsed = new URL(url);

            // `page.tsx:14` parses as protocol `page.tsx:` + pathname `14` — not a real URL.
            if (!['http:', 'https:', 'file:', 'blob:', 'data:'].includes(parsed.protocol)) {
                return url.split(/[?#]/)[0] ?? url;
            }

            return parsed.pathname;
        } catch {
            return url.split(/[?#]/)[0] ?? url;
        }
    })();

    let segment = pathOnly.split(pathSep).filter(Boolean).pop() ?? '';

    // Chip / cite labels append cursor after the basename (`App.tsx:12-20`).
    segment = segment.replace(/:\d+(?::\d+)?(?:-\d+:\d+)?$/, '');
    const dot = segment.lastIndexOf('.');

    if (dot <= 0 || dot === segment.length - 1) {
        return undefined;
    }

    return segment.slice(dot + 1).toLowerCase();
}

/** True when {@link extractExtension} matches a known code/media/document extension. */
export function isKnownFileExtension(pathOrName: string): boolean {
    const ext = extractExtension(pathOrName);

    return ext != null && KNOWN_FILE_EXTENSIONS.has(ext);
}

/** Shiki/highlighter language id from a file path or basename. Unknown ext → `'html'`. */
export function getLanguageFromPath(path: string): string {
    const ext = extractExtension(path);

    if (ext == null) {
        return 'html';
    }

    return EXTENSION_TO_SHIKI_LANGUAGE[ext as keyof typeof EXTENSION_TO_SHIKI_LANGUAGE] ?? 'html';
}
