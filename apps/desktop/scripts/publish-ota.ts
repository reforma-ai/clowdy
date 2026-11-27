/**
 * OTA bundles on GitHub, for .github/workflows/release-ota.yml.
 *
 *   bun scripts/publish-ota.ts                  builds, signs, and publishes the bundle of this commit when it should go out
 *   bun scripts/publish-ota.ts --dry-run <dir>  builds and signs it into <dir> and publishes nothing
 *
 * Bundles live in one permanent prerelease tagged `ota` (a prerelease never becomes Latest, which the shell updater
 * follows): `bundle-<version>.tar.gz` files and one signed `manifest.json` naming the newest. Publishing uploads the
 * archive, then replaces the manifest. Archives are retained so a client that read an older manifest still finds it.
 * The app installs a bundle only on a shell at least `minShell`; so a bundle goes out only when that
 * shell is released and has not changed since (`SHELL_PATHS`), or an older shell would get code that needs a newer one.
 *
 * `CLOWDY_OTA_SIGNING_KEY` is the Ed25519 private key (PKCS#8 PEM); `CLOWDY_OTA_PUBLIC_KEY` must be its public half, the
 * key every shell has baked in. Without both nothing is published: shells built without the key ignore OTA bundles.
 */

import { execFile } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { isVersionAheadOf } from '@clowdy/lib/semver';
import { PROTOCOL_VERSION } from '@clowdy/protocol';

import {
    type BundleManifest,
    MANIFEST_FILE,
    openManifest,
    parseManifest,
    sha256,
    signManifest,
} from '../src/main/bundleManifest';
import { readTar, tarSize } from '../src/main/tar';
import {
    createPrerelease,
    downloadAsset,
    downloadAssetTo,
    listReleases,
    type Release,
    releaseAssets,
    uploadAssets,
} from './github';
import { newestShell, shellTag } from './release-shell';

import type { BundleInfo } from '../src/main/bundle';

const run = promisify(execFile);
// Not `import.meta.dir`: Vitest loads this file in Node.
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '../..');

const OTA_TAG = 'ota';

/**
 * What the shell ships, relative to the repository: a change here since the shell's release means a bundle built now
 * may need a newer shell. The two package files are what the main process inlines and a bundle's daemon or renderer
 * relies on too: the daemon's data folder and the themes main accepts. Two values are compared apart, because their
 * files change for bundles all the time: the Bun the shell ships (`packageManager` in the root package.json) and
 * `PROTOCOL_VERSION`, the one protocol the shell's main process speaks.
 */
export const SHELL_PATHS = [
    'apps/desktop/src/main',
    'apps/desktop/src/preload',
    'apps/desktop/src/shared',
    'apps/desktop/build',
    'apps/desktop/native',
    'apps/desktop/scripts/native-scroll.ts',
    'apps/desktop/electron-builder.ts',
    'apps/desktop/package.json',
    'apps/desktop/scripts/build.ts',
    'apps/desktop/scripts/bun-runtime.ts',
    'apps/desktop/scripts/ripgrep.ts',
    'apps/desktop/scripts/main-bundle.ts',
    'packages/protocol/src/paths.ts',
    'packages/constants/src/theme.ts',
];

const PROTOCOL_SOURCE = 'packages/protocol/src/api.ts';

export type OtaDecision = { decision: 'publish' | 'skip'; reason: string };

export interface OtaDecisionInput {
    bundle: BundleInfo;
    releases: readonly Release[];
    /** Whether the shell's files changed between `v<minShell>` and this commit; undefined when that tag does not exist. */
    shellChanged: boolean | undefined;
    /** The version in the published manifest, or null when none is published. */
    published: number | null;
}

export function decideOta({ bundle, releases, shellChanged, published }: OtaDecisionInput): OtaDecision {
    const skip = (reason: string): OtaDecision => ({ decision: 'skip', reason });
    const shell = newestShell(releases);
    const tag = shellTag(bundle.minShell);

    if (shell === null) return skip('No shell is released yet; the first release carries this bundle');

    if (isVersionAheadOf(bundle.minShell, shell))
        return skip(`Shell ${bundle.minShell} is not released yet; its release carries bundle ${bundle.version}`);

    if (shellChanged === undefined) return skip(`There is no tag ${tag} to compare the shell with`);

    if (shellChanged)
        return skip(
            `The shell changed since ${tag}: raise its version in apps/desktop/package.json, and its release carries bundle ${bundle.version}`
        );

    if (published !== null && published >= bundle.version) return skip(`Bundle ${published} is out already`);

    return { decision: 'publish', reason: `Publishing bundle ${bundle.version} for shells from ${bundle.minShell}` };
}

async function git(args: string[], cwd = repoRoot): Promise<{ code: number; stdout: string }> {
    try {
        return { code: 0, stdout: (await run('git', args, { cwd })).stdout };
    } catch (error) {
        return { code: (error as { code?: number }).code ?? 1, stdout: '' };
    }
}

/**
 * Whether what the shell ships changed between its release tag and HEAD of the repository at `root`; undefined without
 * the tag.
 */
export async function shellChangedSince(tag: string, root = repoRoot): Promise<boolean | undefined> {
    const fileAt = async (ref: string, file: string) => (await git(['show', `${ref}:${file}`], root)).stdout;
    const bunAt = async (ref: string) =>
        (JSON.parse((await fileAt(ref, 'package.json')) || '{}') as { packageManager?: string }).packageManager;
    // Other lockfile entries affect the OTA bundle, not the shell. Only the headers used to compile the addon matter here.
    const nativeHeadersAt = async (ref: string) =>
        /^ {4}"node-api-headers": .+$/m.exec(await fileAt(ref, 'bun.lock'))?.[0];
    const protocolAt = async (ref: string) => {
        const declared = /^export const PROTOCOL_VERSION\b[^=]*=\s*(\d+)/m.exec(
            await fileAt(ref, PROTOCOL_SOURCE)
        )?.[1];

        // A moved constant must not read as an unchanged one.
        if (declared === undefined)
            throw new Error(`No PROTOCOL_VERSION in ${PROTOCOL_SOURCE} at ${ref}: update publish-ota.ts`);

        return Number(declared);
    };

    if ((await git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], root)).code !== 0) return undefined;

    if ((await git(['diff', '--quiet', tag, 'HEAD', '--', ...SHELL_PATHS], root)).code !== 0) return true;

    return (
        (await bunAt(tag)) !== (await bunAt('HEAD')) ||
        (await protocolAt(tag)) !== (await protocolAt('HEAD')) ||
        (await nativeHeadersAt(tag)) !== (await nativeHeadersAt('HEAD'))
    );
}

async function publishedVersion(): Promise<number | null> {
    const signed = await downloadAsset(OTA_TAG, MANIFEST_FILE);

    if (signed === undefined) return null;

    return parseManifest((JSON.parse(signed) as { body: string }).body).version;
}

/** The private key, checked against the public key the shells carry. */
function signingKeys(): { privateKey: string; publicKey: string } | undefined {
    const privateKey = process.env.CLOWDY_OTA_SIGNING_KEY ?? '';

    if (!privateKey) return undefined;

    const derived = createPublicKey(createPrivateKey(privateKey));

    if (derived.asymmetricKeyType !== 'ed25519')
        throw new Error(`CLOWDY_OTA_SIGNING_KEY must be an Ed25519 key, got ${derived.asymmetricKeyType}`);

    const publicKey = derived.export({ type: 'spki', format: 'pem' }).toString();
    const baked = process.env.CLOWDY_OTA_PUBLIC_KEY;

    if (baked && createPublicKey(baked).export({ type: 'spki', format: 'pem' }).toString() !== publicKey) {
        throw new Error(
            'CLOWDY_OTA_SIGNING_KEY does not match CLOWDY_OTA_PUBLIC_KEY, which the shells check bundles with'
        );
    }

    return { privateKey, publicKey };
}

/** Builds and signs the bundle into `outdir`: `bundle-<version>.tar.gz` and `manifest.json`. */
async function buildSigned(
    outdir: string,
    keys: { privateKey: string; publicKey: string }
): Promise<{ manifest: BundleManifest; archive: string; manifestFile: string }> {
    // Imported here: it runs Bun's bundler, which a Node test never needs.
    const { buildOtaBundle } = await import('./bundle');
    const { manifest, archive } = await buildOtaBundle(outdir);
    const signed = JSON.stringify(signManifest(manifest, keys.privateKey));

    openManifest(signed, keys.publicKey);

    const manifestFile = path.join(outdir, MANIFEST_FILE);

    await writeFile(manifestFile, signed);

    return { manifest, archive, manifestFile };
}

/** Validate the complete artifact as the shell will consume it before publishing any installer. */
export async function verifyBootstrap(dir: string, publicKey: string, shellVersion: string): Promise<string> {
    const manifest = openManifest(await readFile(path.join(dir, MANIFEST_FILE), 'utf8'), publicKey);

    if (
        manifest.minShell !== shellVersion ||
        manifest.protocol !== PROTOCOL_VERSION ||
        manifest.archive.name !== `bundle-${manifest.version}.tar.gz`
    )
        throw new Error('Incompatible bootstrap bundle');

    const required = [
        'renderer/index.html',
        'daemon/main.js',
        'daemon/mcp-stdio.js',
        'daemon/clowdy.js',
        'system-skills/.claude-plugin/plugin.json',
    ];
    if (
        required.some(file => !manifest.files[file]) ||
        !Object.keys(manifest.files).some(file => file.startsWith('system-skills/skills/'))
    ) {
        throw new Error('Bootstrap bundle is missing required files');
    }

    const archive = await readFile(path.join(dir, manifest.archive.name));
    if (archive.length !== manifest.archive.size || sha256(archive) !== manifest.archive.sha256)
        throw new Error('Bootstrap archive does not match its manifest');
    const expected = new Map(Object.entries(manifest.files));
    const entries = readTar(
        gunzipSync(archive, { maxOutputLength: tarSize([...expected.values()].map(file => file.size)) })
    );
    for (const entry of entries) {
        const file = expected.get(entry.path);
        if (!file || entry.data.length !== file.size || sha256(entry.data) !== file.sha256)
            throw new Error('Bootstrap archive contains an invalid file');
        expected.delete(entry.path);
    }
    if (expected.size) throw new Error('Bootstrap archive is missing files');
    return manifest.archive.name;
}

async function prepareBootstrap(outdir: string): Promise<void> {
    await mkdir(outdir, { recursive: true });
    const { buildOtaBundle } = await import('./bundle');
    const { manifest } = await buildOtaBundle(outdir);
    await writeFile(path.join(outdir, '.bootstrap-unsigned.json'), JSON.stringify(manifest));
}

async function signBootstrap(outdir: string): Promise<void> {
    if (!process.env.CLOWDY_OTA_PUBLIC_KEY) throw new Error('CLOWDY_OTA_PUBLIC_KEY is required');
    const keys = signingKeys();
    if (!keys) throw new Error('CLOWDY_OTA_SIGNING_KEY is required');
    const manifest = parseManifest(await readFile(path.join(outdir, '.bootstrap-unsigned.json'), 'utf8'));
    await writeFile(path.join(outdir, MANIFEST_FILE), JSON.stringify(signManifest(manifest, keys.privateKey)));
    const { version } = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8')) as {
        version: string;
    };
    await verifyBootstrap(outdir, keys.publicKey, version);
    console.log(`Verified bootstrap ${manifest.version}`);
}

async function publish(): Promise<void> {
    const keys = signingKeys();

    if (!keys) {
        console.log('::notice title=No OTA bundle::CLOWDY_OTA_SIGNING_KEY is not set, so nothing is published');

        return;
    }

    // Shells bake the variable in; built without it, none could check this bundle.
    if (!process.env.CLOWDY_OTA_PUBLIC_KEY) {
        console.log(
            '::notice title=No OTA bundle::CLOWDY_OTA_PUBLIC_KEY is not set, so no shell could check a bundle and nothing is published'
        );

        return;
    }

    const { bundleInfo } = await import('./bundle');
    const bundle = await bundleInfo();
    const result = decideOta({
        bundle,
        releases: await listReleases(),
        shellChanged: await shellChangedSince(shellTag(bundle.minShell)),
        published: await publishedVersion(),
    });

    if (result.decision === 'skip') {
        console.log(`::notice title=No OTA bundle::${result.reason}`);

        return;
    }

    console.log(result.reason);

    const outdir = await mkdtemp(path.join(tmpdir(), 'clowdy-ota-'));

    try {
        const { archive, manifestFile } = await buildSigned(outdir, keys);
        const target = process.env.GITHUB_SHA ?? (await git(['rev-parse', 'HEAD'])).stdout.trim();

        if ((await releaseAssets(OTA_TAG)) === undefined) {
            await createPrerelease({
                tag: OTA_TAG,
                title: 'OTA bundles',
                notes: 'Renderer and daemon updates the app installs by itself. Download the app from the release marked Latest.',
                target,
            });
        }

        // Never replace an archive: a client may already hold a manifest naming it.
        // A retry may reuse an identical archive left by an interrupted publish.
        if (((await releaseAssets(OTA_TAG)) ?? []).includes(path.basename(archive))) {
            const existing = await mkdtemp(path.join(tmpdir(), 'clowdy-ota-existing-'));
            try {
                await downloadAssetTo(OTA_TAG, path.basename(archive), existing);
                if (
                    sha256(await readFile(path.join(existing, path.basename(archive)))) !==
                    sha256(await readFile(archive))
                ) {
                    throw new Error(`Archive ${path.basename(archive)} already exists with different contents`);
                }
            } finally {
                await rm(existing, { recursive: true, force: true });
            }
        } else await uploadAssets(OTA_TAG, [archive]);
        await uploadAssets(OTA_TAG, [manifestFile], true);

        console.log(`Published bundle ${bundle.version}`);
    } finally {
        await rm(outdir, { recursive: true, force: true });
    }
}

/** A local build: signed with `CLOWDY_OTA_SIGNING_KEY`, or with a throwaway key whose public half it prints. */
async function dryRun(outdir: string): Promise<void> {
    let keys = signingKeys();

    if (!keys) {
        const pair = generateKeyPairSync('ed25519');

        keys = {
            privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
            publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        };
        console.log(`Signed with a throwaway key. Its public half:\n${keys.publicKey}`);
    }

    await mkdir(outdir, { recursive: true });

    const { manifest, archive } = await buildSigned(outdir, keys);

    console.log(
        `Bundle ${manifest.version} (minShell ${manifest.minShell}): ${archive}, ${Object.keys(manifest.files).length} files`
    );
}

if (import.meta.main) {
    const [flag, dir] = process.argv.slice(2);

    if (flag === '--prepare-bootstrap' && dir) await prepareBootstrap(path.resolve(dir));
    else if (flag === '--sign-bootstrap' && dir) await signBootstrap(path.resolve(dir));
    else if (flag === '--dry-run' && dir) await dryRun(path.resolve(dir));
    else if (flag === undefined) await publish();
    else {
        console.error(
            'Usage: bun scripts/publish-ota.ts [--dry-run <dir> | --prepare-bootstrap <dir> | --sign-bootstrap <dir>]'
        );
        process.exit(1);
    }
}
