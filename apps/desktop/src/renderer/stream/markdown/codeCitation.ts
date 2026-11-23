import { isKnownFileExtension } from '@clowdy/lib';

import { isDirectoryPath, isWorkspaceRoot } from './chipPath';

export type CodeFenceInfo =
    | { kind: 'language'; language: string }
    | { kind: 'file'; path: string; startLine?: number; endLine?: number };

function fenceInfoString(className?: string): string | undefined {
    return className?.match(/language-(.+)/)?.[1];
}

/** Strip optional `@` prefix from chat file references (`@app/page.tsx`). */
export function normalizeFileReferencePath(text: string): string {
    return text.trim().replace(/^@+/, '');
}

export function parseCodeFenceInfo(className?: string): CodeFenceInfo {
    const info = fenceInfoString(className);

    if (!info) {
        return { kind: 'language', language: 'text' };
    }

    const rangeMatch = info.match(/^(\d+):(\d+):(.+)$/);

    if (rangeMatch) {
        return {
            kind: 'file',
            path: normalizeFileReferencePath(rangeMatch[3]),
            startLine: Number(rangeMatch[1]),
            endLine: Number(rangeMatch[2]),
        };
    }

    const path = normalizeFileReferencePath(info);

    if (isFilePathLike(path)) {
        return { kind: 'file', path };
    }

    return { kind: 'language', language: info };
}

/** Glob path masks — inline code only, not file Chips. */
function isGlobPattern(text: string): boolean {
    return /[*?[\]{}]/.test(text);
}

/** Whether streamdown should render inline/fenced path citations as file Chips. */
export function isFilePathLike(text: string): boolean {
    const trimmed = normalizeFileReferencePath(text);

    if (!trimmed) {
        return false;
    }

    // Commands that mention a path (`ls dir/`, `grep x package.json`) are not citations.
    if (/\s/.test(trimmed)) {
        return false;
    }

    // An address (`http://localhost:5173/main.ts`) is not a file of the project.
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
        return false;
    }

    if (isGlobPattern(trimmed)) {
        return false;
    }

    if (isDirectoryPath(trimmed)) {
        const stem = trimmed.replace(/[/\\]+$/, '');

        // `./`, `/`, etc. are workspace roots — keep as inline code, not Chips.
        if (!stem || isWorkspaceRoot(stem)) {
            return false;
        }

        return true;
    }

    return isKnownFileExtension(trimmed);
}
