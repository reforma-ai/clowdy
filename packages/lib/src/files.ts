export type FormatFileSizeOptions = {
    /**
     * `nearest` (default): round KB, always one decimal for MB.
     * `up`: ceil KB (min 1 KB above 0 B); whole MB when exact, else one decimal.
     */
    round?: 'nearest' | 'up';
};

/** Human-readable byte size (B / KB / MB). */
export function formatFileSize(bytes: number, options?: FormatFileSizeOptions): string {
    const roundUp = options?.round === 'up';

    if (!Number.isFinite(bytes) || bytes < 0) {
        return '0 B';
    }

    if (bytes === 0) {
        return '0 B';
    }

    if (bytes < 1024) {
        return roundUp ? '1 KB' : `${ bytes } B`;
    }

    if (bytes < 1024 * 1024) {
        const kb = roundUp
            ? Math.max(1, Math.ceil(bytes / 1024))
            : Math.round(bytes / 1024);

        return `${ kb } KB`;
    }

    const mb = bytes / (1024 * 1024);

    if (roundUp && mb === Math.floor(mb)) {
        return `${ Math.round(mb) } MB`;
    }

    return `${ mb.toFixed(1) } MB`;
}

/** `URL.createObjectURL`, or `null` when the API is unavailable. */
export function createObjectURL(source: Blob | MediaSource): string | null {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        return null;
    }

    return URL.createObjectURL(source);
}

/** Revoke a `blob:` object URL; no-op for other strings / missing API. */
export function revokeObjectURL(url: string | null | undefined): void {
    if (
        !url
        || !url.startsWith('blob:')
        || typeof URL === 'undefined'
        || typeof URL.revokeObjectURL !== 'function'
    ) {
        return;
    }

    URL.revokeObjectURL(url);
}

/** Prefer image extensions from a MIME / media type string. */
export function extensionForMediaType(mediaType: string): string {
    const type = mediaType.toLowerCase();

    if (type.includes('jpeg') || type.includes('jpg')) {
        return 'jpg';
    }

    if (type.includes('webp')) {
        return 'webp';
    }

    if (type.includes('gif')) {
        return 'gif';
    }

    if (type.includes('svg')) {
        return 'svg';
    }

    if (type.includes('png')) {
        return 'png';
    }

    return 'png';
}

const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
};

/** MIME for a known image extension; `undefined` when unknown. */
export function mediaTypeForExtension(ext: string): string | undefined {
    const normalized = ext.replace(/^\./, '').toLowerCase();

    return MEDIA_TYPE_BY_EXTENSION[normalized];
}

/**
 * Collect {@link File}s from a drag/drop or clipboard {@link DataTransfer}.
 * Prefers `files`; falls back to `items` of kind `file`.
 */
export function filesFromDataTransfer(dataTransfer: DataTransfer | null | undefined): File[] {
    if (!dataTransfer) {
        return [];
    }

    if (dataTransfer.files.length > 0) {
        return Array.from(dataTransfer.files);
    }

    const fromItems: File[] = [];

    for (const item of dataTransfer.items) {
        if (item.kind !== 'file') {
            continue;
        }

        const file = item.getAsFile();

        if (file) {
            fromItems.push(file);
        }
    }

    return fromItems;
}
