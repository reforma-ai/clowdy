import { isVersionAheadOf } from '@clowdy/lib/semver';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

import { renameWhenFree } from './bundle';
import { MANIFEST_FILE, openManifest, RENDERER_DIR, rendererFiles, sha256, type BundleFiles, type BundleManifest } from './bundleManifest';
import { readTar, tarSize } from './tar';

const READY_TIMEOUT_MS = 30_000;
const STATE_FILE = 'state.json';
/** A real manifest is a few hundred KB. */
const MANIFEST_LIMIT = 4_000_000;
/** Files hashed at once when an installed bundle is checked. */
const HASHES_AT_ONCE = 32;

const gunzipAsync = promisify(gunzip);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The bundle this process runs: its renderer is served from `app://clowdy`, and its daemon is the one the app wants. */
export interface RunningBundle {
    /** The bundle version; 0 for a development run's own sources. */
    version: number;
    /** The folder the renderer is served from. */
    rendererRoot: string;
    /** An installed bundle's folder (`daemon/`, `system-skills/`); null for the app's own copy. */
    dir: string | null;
    /** The renderer's files, which every read must match; null for the app's own copy, which the signed app carries. */
    rendererFiles: BundleFiles | null;
}

/**
 * `current` is the installed bundle to run, `previous` the one to fall back to; null means the app's own copy.
 * `unconfirmed`: `current` has not called `ready()` since it took over. A rejected version is never installed again.
 */
interface OtaState {
    current: number | null;
    previous: number | null;
    unconfirmed: boolean;
    rejected: number[];
}

const NO_STATE: OtaState = { current: null, previous: null, unconfirmed: false, rejected: [] };

export interface OtaOptions {
    /** `updatesDir(dataDir)`: installed bundles in `bundles/<version>`, the choice in `state.json`. */
    updates: string;
    /** The app's own copy: the floor every choice falls back to. */
    own: RunningBundle;
    shellVersion: string;
    /**
     * The shell's `PROTOCOL_VERSION`. A bundle must speak it: the shell compares daemons against it, so a protocol change
     * ships as a shell release (`publish-ota.ts` holds bundles back until one is out).
     */
    protocol: number;
    /** The Ed25519 key manifests must be signed with (SPKI PEM); empty turns OTA off and ignores installed bundles. */
    publicKey: string;
    /** Where `manifest.json` and the archives are published, without a trailing slash; empty turns checks off. */
    feed: string;
    fetch: (url: string) => Promise<Response>;
    /**
     * The bundle version the running daemon reports, if one runs: its folder is never deleted. Rejects when a daemon runs
     * but does not say which bundle it is; nothing is deleted then.
     */
    daemonVersion: () => Promise<number | undefined>;
    /** Restarts the app: into an installed bundle, or away from a rejected one. */
    relaunch: () => void;
    /** A bundle finished installing and runs from the next launch. */
    onInstalled?: (version: number) => void;
    log?: (message: string) => void;
    readyTimeoutMs?: number;
}

export type Ota = ReturnType<typeof createOta>;

/**
 * Over-the-air bundles: renderer, daemon, and system skills from one commit (`bundleManifest.ts`). At start the app runs
 * the newest installed bundle that verifies, without touching the network. A check downloads a newer signed bundle,
 * checks every file against its manifest, renames it into place, and switches `state.json` with one rename; it runs
 * from the next launch. A bundle whose renderer does not call `ready()` within 30 seconds of its first launch is
 * rejected and the previous one runs; until it calls it, nothing is installed over it. A daemon it already started stays
 * (`fromOlderBundle`): it may have moved the database past what the previous bundle's daemon opens.
 */
export function createOta(options: OtaOptions) {
    const { own, updates, publicKey, feed, log = () => undefined } = options;
    const bundles = path.join(updates, 'bundles');
    let running: RunningBundle = own;
    /** The running bundle took over at this launch and has not called `ready()` yet. */
    let onTrial = false;
    let checking: Promise<number | null> | undefined;
    /** The newest bundle installed during this run: it runs from the next launch. */
    let installedVersion: number | null = null;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    /** Installs and prunes touch the same folder, one at a time. */
    let busy: Promise<unknown> = Promise.resolve();

    const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
        const result = busy.then(work);

        busy = result.catch(() => undefined);

        return result;
    };

    const enabled = Boolean(publicKey && feed);

    /** The newest installed bundle that verifies, is not rejected, and this shell can run; otherwise the app's own copy. */
    async function choose(): Promise<RunningBundle> {
        if (!publicKey) return running = own;

        const state = await readState();

        for (const version of [state.current, state.previous]) {
            if (version === null || version <= own.version || state.rejected.includes(version)) continue;

            const manifest = await installed(version);

            if (manifest) {
                const dir = path.join(bundles, String(version));

                onTrial = state.unconfirmed && version === state.current;

                return running = { version, rendererRoot: path.join(dir, RENDERER_DIR), dir, rendererFiles: rendererFiles(manifest.files) };
            }
        }

        return running = own;
    }

    /** Starts the ready clock when the running bundle is on its first launch. */
    function watchReady(): void {
        if (onTrial) {
            readyTimer = setTimeout(() => {
                rollBack().catch((error: unknown) => log(`Could not go back from bundle ${ running.version }: ${ errorText(error) }`));
            }, options.readyTimeoutMs ?? READY_TIMEOUT_MS);
        }
    }

    /** The running bundle's page rendered: it stays, and the check its trial held back runs. */
    async function ready(): Promise<void> {
        if (!onTrial) return;

        onTrial = false;
        clearTimeout(readyTimer);
        await writeState({ ...await readState(), unconfirmed: false });
        check().catch((error: unknown) => log(`The update check failed: ${ errorText(error) }`));
    }

    async function rollBack(): Promise<void> {
        if (!onTrial) return;

        onTrial = false;

        const state = await readState();

        log(`Bundle ${ running.version } did not start; going back to ${ state.previous ?? 'the app\'s own copy' }.`);
        // The previous bundle proves itself again; if it fails too, the app's own copy runs.
        await writeState({
            current: state.previous,
            previous: null,
            unconfirmed: state.previous !== null,
            rejected: [...state.rejected, running.version],
        });
        options.relaunch();
    }

    /**
     * Installs the published bundle when it is newer and this shell can run it, for the next launch. Resolves to its
     * version, or null when there is nothing to install (or the running bundle is on trial). Rejects when the feed or
     * the download fails; what is installed stays.
     */
    function check(): Promise<number | null> {
        // A bundle on trial is never replaced: it would escape its rollback, and `previous` would be unproven.
        if (!enabled || onTrial) return Promise.resolve(null);

        checking ??= installNewer().finally(() => {
            checking = undefined;
        });

        return checking;
    }

    async function installNewer(): Promise<number | null> {
        const response = await options.fetch(`${ feed }/${ MANIFEST_FILE }`);

        // Nothing published yet, or the repository is still private.
        if (response.status === 404) return null;

        if (!response.ok) throw new Error(`The bundle manifest answered ${ response.status }`);

        const signed = new TextDecoder().decode(await readBody(response, MANIFEST_LIMIT));
        const manifest = openManifest(signed, publicKey);
        const state = await readState();

        if (manifest.version <= Math.max(running.version, installedVersion ?? 0)
            || state.rejected.includes(manifest.version) || !compatible(manifest)) {
            return null;
        }

        // The app's own copy is the floor anyway; only an installed bundle is worth going back to.
        const previous = running.dir ? running.version : null;

        // The state switches in the same turn as the install, so a prune never sees the new folder without the state that keeps it.
        await exclusive(async () => {
            await install(manifest, signed);
            await writeState({ ...await readState(), current: manifest.version, previous, unconfirmed: true });
        });
        installedVersion = manifest.version;
        log(`Installed bundle ${ manifest.version }; it runs from the next launch.`);
        options.onInstalled?.(manifest.version);
        await prune();

        return manifest.version;
    }

    async function install(manifest: BundleManifest, signed: string): Promise<void> {
        const target = path.join(bundles, String(manifest.version));

        // Installed by a run that ended before it wrote `state.json`.
        if (await installed(manifest.version)) return;

        const { name, sha256: archiveHash, size } = manifest.archive;
        const response = await options.fetch(`${ feed }/${ name }`);

        if (!response.ok) throw new Error(`${ name } answered ${ response.status }`);

        const archive = await readBody(response, size);

        if (archive.length !== size || sha256(archive) !== archiveHash) throw new Error(`${ name } does not match the manifest`);

        const expected = new Map(Object.entries(manifest.files));
        // The tar `writeTar` makes of the manifest's files: a larger one is not this bundle.
        const limit = tarSize([...expected.values()].map(file => file.size));
        const entries = await gunzipAsync(archive, { maxOutputLength: limit }).then(readTar, (error: unknown) => {
            throw new Error(`${ name } does not match the manifest: ${ errorText(error) }`);
        });
        const staging = path.join(bundles, `.staging-${ manifest.version }-${ randomBytes(4).toString('hex') }`);

        try {
            for (const entry of entries) {
                const file = expected.get(entry.path);

                // Only the manifest's paths are written, and those are checked to stay inside the folder.
                if (!file || entry.data.length !== file.size || sha256(entry.data) !== file.sha256) {
                    throw new Error(`${ entry.path } in ${ name } does not match the manifest`);
                }

                expected.delete(entry.path);
                await mkdir(path.dirname(path.join(staging, entry.path)), { recursive: true });
                await writeFile(path.join(staging, entry.path), entry.data);
            }

            const [missing] = expected.keys();

            if (missing !== undefined) throw new Error(`${ name } lacks ${ missing }`);

            await writeFile(path.join(staging, MANIFEST_FILE), signed);
            await rm(target, { recursive: true, force: true });
            await renameWhenFree(staging, target);
        }
        finally {
            await rm(staging, { recursive: true, force: true });
        }
    }

    /** The manifest of an installed bundle whose signature, compatibility, and every file's hash check out. */
    async function installed(version: number): Promise<BundleManifest | null> {
        const dir = path.join(bundles, String(version));

        try {
            const manifest = openManifest(await readFile(path.join(dir, MANIFEST_FILE), 'utf8'), publicKey);

            if (manifest.version !== version || !compatible(manifest)) return null;

            const files = Object.entries(manifest.files);

            // An altered or half-deleted file would otherwise leave a blank window or a daemon that cannot start.
            for (let start = 0; start < files.length; start += HASHES_AT_ONCE) {
                const results = await Promise.all(files.slice(start, start + HASHES_AT_ONCE).map(async ([file, expected]) => {
                    const bytes = await readFile(path.join(dir, file));

                    return bytes.length === expected.size && sha256(bytes) === expected.sha256;
                }));

                if (results.includes(false)) return null;
            }

            return manifest;
        }
        catch {
            return null;
        }
    }

    function compatible(manifest: BundleManifest): boolean {
        return manifest.protocol === options.protocol && !isVersionAheadOf(manifest.minShell, options.shellVersion);
    }

    /**
     * Deletes the installed bundles nothing needs and abandoned copies. Kept: the current and previous choice, the running
     * bundle, the app's own copy, and the bundle of the running daemon, which still starts its MCP bridge and reads its
     * skills from its folder.
     */
    function prune(): Promise<void> {
        return exclusive(async () => {
            let daemon: number | undefined;

            try {
                daemon = await options.daemonVersion();
            }
            catch (error) {
                log(`Not deleting old bundles now: ${ errorText(error) }`);

                return;
            }

            const state = await readState();
            const keep = new Set([state.current, state.previous, own.version, running.version, daemon].map(String));

            for (const entry of await readdir(bundles).catch(() => [] as string[])) {
                if (keep.has(entry)) continue;

                // Windows refuses to delete a file that is open; the next prune tries again.
                await rm(path.join(bundles, entry), { recursive: true, force: true })
                    .catch((error: unknown) => log(`Could not delete ${ entry }: ${ errorText(error) }`));
            }
        });
    }

    async function readState(): Promise<OtaState> {
        try {
            const state = JSON.parse(await readFile(path.join(updates, STATE_FILE), 'utf8')) as Partial<OtaState>;
            const version = (value: unknown) => (Number.isSafeInteger(value) ? value as number : null);

            return {
                current: version(state.current),
                previous: version(state.previous),
                unconfirmed: state.unconfirmed === true,
                rejected: Array.isArray(state.rejected) ? state.rejected.filter(Number.isSafeInteger) : [],
            };
        }
        catch {
            return NO_STATE;
        }
    }

    /** One rename switches the choice, so a crash leaves the old state or the new one. */
    async function writeState(state: OtaState): Promise<void> {
        const file = path.join(updates, STATE_FILE);

        await mkdir(updates, { recursive: true });
        await writeFile(`${ file }.tmp`, JSON.stringify(state));
        await rename(`${ file }.tmp`, file);
    }

    /** Restarts into the installed bundle; nothing installed, nothing happens. */
    function restart(): void {
        if (installedVersion !== null) options.relaunch();
    }

    return { enabled, choose, watchReady, ready, check, prune, restart, pending: () => installedVersion };
}

/** The body, refused past `limit` bytes, so a hostile host cannot exhaust memory with an endless one. */
async function readBody(response: Response, limit: number): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let length = 0;

    for await (const chunk of response.body ?? []) {
        length += chunk.length;

        // Leaving the loop cancels the download.
        if (length > limit) throw new Error(`${ response.url || 'A download' } is larger than ${ limit } bytes`);

        chunks.push(chunk);
    }

    return Buffer.concat(chunks);
}
