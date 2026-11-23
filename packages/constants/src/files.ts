/** Lowercase path suffix without a dot (e.g. `jpg`), for URL/path classification. */
export const IMAGE_EXTENSIONS: readonly string[] = [
    'jpeg',
    'jpg',
    'png',
    'gif',
    'webp',
    'avif',
    'bmp',
    'svg',
    'svgz',
    'ico',
    'jfif',
    'pjpeg',
    'pjp',
    'heic',
    'heif',
    'apng',
];

export const AUDIO_EXTENSIONS: readonly string[] = [
    'mp3',
    'wav',
    'ogg',
    'oga',
    'opus',
    'm4a',
    'm4b',
    'm4p',
    'aac',
    'flac',
    'weba',
    'wma',
    'aif',
    'aiff',
    'caf',
    'mid',
    'midi',
    'amr',
];

export const VIDEO_EXTENSIONS: readonly string[] = [
    'mp4',
    'webm',
    'ogv',
    'mov',
    'm4v',
    'mkv',
    'avi',
    '3gp',
    '3g2',
    'm2ts',
    'f4v',
    'asf',
    'wmv',
];

export const PAGE_EXTENSIONS: readonly string[] = ['html', 'htm', 'xhtml', 'mhtml'];

export const DOCUMENT_EXTENSIONS: readonly string[] = [
    'pdf',
    'doc',
    'docx',
    'xls',
    'xlsx',
    'ppt',
    'pptx',
    'odt',
    'ods',
    'odp',
    'rtf',
    'txt',
    'csv',
    'tsv',
    'epub',
    'pages',
    'numbers',
    'key',
    'vcf',
    'vcard',
];

export const CODE_EXTENSIONS: readonly string[] = [
    'js',
    'cjs',
    'mjs',
    'ts',
    'mts',
    'cts',
    'tsx',
    'jsx',
    'css',
    'scss',
    'sass',
    'less',
    'styl',
    'vue',
    'svelte',
    'json',
    'json5',
    'jsonc',
    'md',
    'mdx',
    'graphql',
    'gql',
    'xml',
    'sql',
    'wasm',
    'php',
    'py',
    'rb',
    'go',
    'rs',
    'java',
    'kt',
    'kts',
    'swift',
    'c',
    'h',
    'cpp',
    'hpp',
    'cc',
    'cxx',
    'cs',
    'fs',
    'fsx',
    'sh',
    'bash',
    'zsh',
    'ps1',
    'bat',
    'cmd',
    'yml',
    'yaml',
    'toml',
    'ini',
    'env',
];

const CODE_EXTENSION_SET = new Set(CODE_EXTENSIONS);

function fileNameExtension(fileName: string): string | null {
    const base = fileName.split(/[/\\]/).pop() ?? fileName;
    const dot = base.lastIndexOf('.');

    if (dot <= 0 || dot === base.length - 1) {
        return null;
    }

    return base.slice(dot + 1).toLowerCase();
}

function isTextLikeUploadMime(mime: string): boolean {
    return (
        mime.startsWith('text/') ||
        mime === 'application/json' ||
        mime === 'application/javascript' ||
        mime === 'application/typescript' ||
        mime === 'application/xml'
    );
}

/**
 * Browser MIME for `*.ts` is often `video/mp2t` (MPEG transport stream).
 * Code uploads should still go up as text, not be rejected as media.
 */
export function coerceUploadMimeType(fileName: string, mimeType: string): string {
    const mime = mimeType.split(';')[0].trim().toLowerCase();
    const ext = fileNameExtension(fileName);

    if (ext && ext !== 'wasm' && CODE_EXTENSION_SET.has(ext)) {
        return isTextLikeUploadMime(mime) ? mime : 'text/plain';
    }

    return mime || 'application/octet-stream';
}
