import { extname } from 'node:path';

/** The longest file name kept, in characters; a cut keeps the extension. */
const MAX_NAME_CHARS = 120;
/** File systems cap a name near 255 bytes, and a letter of some languages takes three of them. */
const MAX_NAME_BYTES = 240;
const MAX_EXTENSION_CHARS = 16;
const FALLBACK_NAME = 'file';

// Control characters, and the invisible ones that disguise a name (a right-to-left override turns `gpj.exe` into `exe.jpg`) or
// break its line in the message that lists the file (the line and paragraph separators).
const HIDDEN =
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what it strips
    /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
/** Windows refuses these in a name, and `:` there opens an alternate data stream. */
const FORBIDDEN = /[<>:"|?*]/g;
/** `CON`, `CON.txt` and `CON .txt` are all the device, whatever follows the dot. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[\d\u00B9\u00B2\u00B3]|lpt[\d\u00B9\u00B2\u00B3])\s*(?:\..*)?$/i;

function capLength(name: string): string {
    if ([...name].length <= MAX_NAME_CHARS && Buffer.byteLength(name) <= MAX_NAME_BYTES) {
        return name;
    }

    const extension = extname(name);
    const kept = extension.length > 1 && [...extension].length <= MAX_EXTENSION_CHARS ? extension : '';
    const stem = [...name.slice(0, name.length - kept.length)].slice(0, MAX_NAME_CHARS - [...kept].length);

    while (stem.length > 0 && Buffer.byteLength(stem.join('') + kept) > MAX_NAME_BYTES) {
        stem.pop();
    }

    return stem.join('').replace(/[.\s]+$/, '') + kept;
}

/**
 * A name that is safe to create as a file: the last path segment only (a browser or a script may send `C:\\Users\\me\\a.png` or
 * `../../a`), no control or disguising characters, none Windows refuses, no leading dot (so it is never a hidden file or `..`),
 * at most 120 characters with its extension intact, `file` when nothing is left.
 */
export function safeFileName(raw: string): string {
    const segment =
        raw
            .split(/[/\\]/)
            .map(part => part.replace(HIDDEN, '').replace(FORBIDDEN, '_').trim())
            .filter(Boolean)
            .at(-1) ?? '';
    const name = segment.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    const named = WINDOWS_DEVICE.test(name) ? `_${name}` : name;

    return capLength(named) || FALLBACK_NAME;
}

const TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
/** What a client sends when it knows nothing about the file; the extension may know better. */
const UNINFORMATIVE = new Set(['application/octet-stream', 'binary/octet-stream', 'application/x-www-form-urlencoded']);

const TEXT_EXTENSIONS = [
    'ts',
    'tsx',
    'jsx',
    'py',
    'rb',
    'go',
    'rs',
    'java',
    'kt',
    'swift',
    'c',
    'h',
    'cpp',
    'cs',
    'php',
    'sh',
    'sql',
    'ini',
    'env',
    'log',
    'txt',
];

const BY_EXTENSION: Record<string, string> = {
    ...Object.fromEntries(TEXT_EXTENSIONS.map(extension => [extension, 'text/plain'])),
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    heic: 'image/heic',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    pdf: 'application/pdf',
    md: 'text/markdown',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    json: 'application/json',
    xml: 'application/xml',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    toml: 'application/toml',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    mjs: 'text/javascript',
    zip: 'application/zip',
    gz: 'application/gzip',
    tar: 'application/x-tar',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
};

/**
 * The media type kept for a file: what the client declared when it is a plausible `type/subtype` that says something,
 * else what the extension suggests, else `application/octet-stream`.
 */
export function mediaTypeOf(declared: string | null, fileName: string): string {
    const type = declared?.split(';')[0].trim().toLowerCase() ?? '';

    if (TYPE_PATTERN.test(type) && !UNINFORMATIVE.has(type) && !type.startsWith('multipart/')) {
        return type;
    }

    return BY_EXTENSION[extname(fileName).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/** Types a browser runs or renders as a page: markup, SVG, XML (stylesheets can script it) and the mail-like containers. */
const ACTIVE_TYPE =
    /^(?:text\/(?:html|xml|xsl|cache-manifest)|application\/(?:xhtml\+xml|xml)|image\/svg\+xml|(?:multipart|message)\/.+)$|\+xml$/;

/**
 * The type a file is served under. A page must never run from the daemon's origin, so one a browser would treat as active
 * is served as opaque bytes; its real type stays in the record for the person and the agent.
 */
export function servedMediaType(mediaType: string): string {
    return ACTIVE_TYPE.test(mediaType) ? 'application/octet-stream' : mediaType;
}

/** `Content-Disposition` that shows a file in place and names it for a save, escaped as RFC 5987 asks (`encodeURIComponent` leaves `' ( ) *`). */
export function contentDisposition(fileName: string): string {
    return `inline; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
