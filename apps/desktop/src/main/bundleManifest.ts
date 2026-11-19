import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Every file of a bundle by its `/`-separated path, with its SHA-256 (hex) and size. */
export type BundleFiles = Record<string, { sha256: string; size: number }>;

/** What an OTA bundle is (`scripts/bundle.ts`): renderer, daemon, and system skills from one commit. */
export interface BundleManifest {
    /** First-parent commits on `main` at the built commit, so it only grows. */
    version: number;
    /** The lowest shell version that can run it: the shell's version at the commit it was built from. */
    minShell: string;
    /** `PROTOCOL_VERSION` its daemon serves and its renderer speaks. */
    protocol: number;
    /** The `.tar.gz` the bundle travels in, as published next to the manifest. */
    archive: { name: string; sha256: string; size: number };
    files: BundleFiles;
}

/** The published form: `body` is the exact manifest JSON the release key signed. */
export interface SignedManifest {
    body: string;
    signature: string;
}

/**
 * The signed manifest's file name: the asset next to the archives in the `ota` release, and where an installed bundle
 * keeps it. It is not a file of the bundle itself.
 */
export const MANIFEST_FILE = 'manifest.json';

/** Where the renderer sits inside a bundle. */
export const RENDERER_DIR = 'renderer';

/** Signs a manifest with the Ed25519 release key (PKCS#8 PEM). */
export function signManifest(manifest: BundleManifest, privateKeyPem: string): SignedManifest {
    const body = JSON.stringify(manifest);

    return { body, signature: sign(null, Buffer.from(body), createPrivateKey(privateKeyPem)).toString('base64') };
}

/** The manifest a signed one carries. Throws on a bad signature or a malformed manifest. */
export function openManifest(signed: string, publicKeyPem: string): BundleManifest {
    const { body, signature } = JSON.parse(signed) as Partial<SignedManifest>;

    if (typeof body !== 'string' || typeof signature !== 'string'
        || !verify(null, Buffer.from(body), createPublicKey(publicKeyPem), Buffer.from(signature, 'base64'))) {
        throw new Error('The bundle manifest is not signed by the release key');
    }

    return parseManifest(body);
}

const isHash = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isSize = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

/** A manifest checked field by field, so nothing downstream trusts its shape blindly. */
export function parseManifest(json: string): BundleManifest {
    const manifest = JSON.parse(json) as BundleManifest;
    const valid = Number.isSafeInteger(manifest.version) && manifest.version > 0
        && typeof manifest.minShell === 'string' && /^\d+\.\d+\.\d+$/.test(manifest.minShell)
        && Number.isSafeInteger(manifest.protocol)
        && typeof manifest.archive === 'object' && manifest.archive !== null
        && /^bundle-\d+\.tar\.gz$/.test(manifest.archive.name) && isHash(manifest.archive.sha256) && isSize(manifest.archive.size)
        && typeof manifest.files === 'object' && manifest.files !== null
        && Object.entries(manifest.files).every(([file, entry]) => isBundlePath(file) && isHash(entry?.sha256) && isSize(entry?.size));

    if (!valid) throw new Error('The bundle manifest is malformed');

    return manifest;
}

/**
 * Every file under `root` except the manifest, hashed, by its `/`-separated path. A bundle is regular files only, so a
 * link or any other kind of entry is refused rather than left out.
 */
export async function hashFolder(root: string): Promise<BundleFiles> {
    const files: BundleFiles = {};
    const entries = await readdir(root, { recursive: true, withFileTypes: true });

    for (const entry of entries.sort((a, b) => path.join(a.parentPath, a.name).localeCompare(path.join(b.parentPath, b.name)))) {
        if (entry.isDirectory()) continue;

        const file = path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');

        if (!entry.isFile()) throw new Error(`${ file } is not a regular file, and a bundle holds only those`);

        if (file === MANIFEST_FILE) continue;

        const bytes = await readFile(path.join(root, file));

        files[file] = { sha256: sha256(bytes), size: bytes.length };
    }

    return files;
}

export function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/** A relative `/`-separated path that stays inside the bundle's folder on every OS. */
export function isBundlePath(file: string): boolean {
    return file.length > 0
        && file !== MANIFEST_FILE
        && !file.startsWith('/')
        && !/[\\:\0]/.test(file)
        && file.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}
