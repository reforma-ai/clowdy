import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { type BundleFiles, sha256 } from './bundleManifest';
import { APP_HOST } from './security';

export const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    // No remote images: an image request would be a way out for page data. Remote content goes through the daemon.
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    // Loopback only: the daemon listens there with a local token (see spec §5).
    "connect-src 'self' data: blob: http://127.0.0.1:* ws://127.0.0.1:*",
    // `blob:` for the file manager's PDF preview, which frames the file as a PDF blob.
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    // No page of the app is ever framed.
    "frame-ancestors 'none'",
].join('; ');

const CONTENT_TYPES: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.mjs': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

/**
 * Handler for `app://clowdy`: every path is a file under `root`, and unknown routes get its `index.html`. `files`, an
 * installed bundle's renderer files from its signed manifest, makes every read match its hash; the app's own copy has none.
 */
export function createProtocolHandler(root: string, files: BundleFiles | null = null) {
    return async (request: Request): Promise<Response> => {
        const url = new URL(request.url);

        if (url.host !== APP_HOST) return respond('Not found', 404);

        const file = await resolveFile(root, url.pathname);

        if (!file) return respond('Not found', 404);

        const body = await readFile(file.path);

        // A file altered after the bundle was checked at launch is not served.
        if (files && files[file.name]?.sha256 !== sha256(body)) return respond('Not found', 404);

        const type = CONTENT_TYPES[path.extname(file.path).toLowerCase()] ?? 'application/octet-stream';

        return respond(body, 200, new Headers({ 'content-type': type }));
    };
}

/**
 * A file under the root: the path itself, its `index.html`, or the root `index.html` for an app route, with its
 * `/`-separated name under the root. Refuses anything that resolves outside the root.
 */
async function resolveFile(root: string, pathname: string): Promise<{ path: string; name: string } | null> {
    const decoded = decodePath(pathname);
    const realRoot = await realpath(root).catch(() => null);

    if (decoded === undefined || !realRoot) return null;

    const candidate = path.join(realRoot, decoded);
    const found =
        (await existingFile(candidate)) ??
        (await existingFile(path.join(candidate, 'index.html'))) ??
        (path.extname(candidate) ? null : await existingFile(path.join(realRoot, 'index.html')));

    if (!found) return null;

    const real = await realpath(found);
    const relative = path.relative(realRoot, real);
    const inside =
        relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);

    return inside ? { path: real, name: relative.split(path.sep).join('/') } : null;
}

/** The decoded path; undefined for a malformed escape. */
function decodePath(pathname: string): string | undefined {
    try {
        return decodeURIComponent(pathname);
    } catch {
        return undefined;
    }
}

async function existingFile(file: string): Promise<string | null> {
    const stats = await stat(file).catch(() => null);

    return stats?.isFile() ? file : null;
}

function respond(body: BodyInit | null, status: number, headers = new Headers()): Response {
    headers.set('content-security-policy', CONTENT_SECURITY_POLICY);

    return new Response(body, { status, headers });
}
