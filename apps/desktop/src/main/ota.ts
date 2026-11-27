import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { isVersionAheadOf } from '@clowdy/lib/semver';

import { renameWhenFree } from './bundle';
import {
    type BundleFiles,
    type BundleManifest,
    MANIFEST_FILE,
    openManifest,
    RENDERER_DIR,
    rendererFiles,
    sha256,
} from './bundleManifest';
import { daemonHoldsLock, restoreDatabase } from './daemonFiles';
import { readTar, tarSize } from './tar';

const READY_TIMEOUT_MS = 30_000;
/** How far a backup's time may lag the launch's (a file system that keeps whole seconds) and still count as this launch's. */
const CLOCK_SLACK_MS = 2000;
/** What the first launch of a shell version waits for before its first window: the manifest, then the download. */
const CATCH_UP_MS = { manifest: 3000, install: 60_000 };
/** How many bundles whose daemon came up healthy `state.json` remembers. */
const PROVEN_KEPT = 10;
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
 * `proven`: bundles whose daemon came up healthy once, so a later failure of theirs is no reason to go back.
 * `shell`: the shell version whose first launch has had its catch-up.
 */
interface OtaState {
    current: number | null;
    previous: number | null;
    unconfirmed: boolean;
    rejected: number[];
    proven: number[];
    shell: string | null;
}

const NO_STATE: OtaState = { current: null, previous: null, unconfirmed: false, rejected: [], proven: [], shell: null };

/** A launch waiting for a bundle: its progress, 0 to 1 once the download begins, and how long it waits. */
interface Waiting {
    onProgress: (fraction: number) => void;
    wait: { manifest: number; install?: number };
}

export interface OtaOptions {
    /** `updatesDir(dataDir)`: installed bundles in `bundles/<version>`, the choice in `state.json`. */
    updates: string;
    /** The daemon's data folder: a bundle whose daemon fails its first start puts back the database it migrated there. */
    dataDir: string;
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
    /** The immutable bootstrap assets published with this shell. */
    bootstrapFeed?: string;
    fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
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
    catchUpMs?: typeof CATCH_UP_MS;
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
    /** A backup written since then is this launch's. */
    const launchedAt = Date.now();
    let daemonFailure: Promise<boolean> | undefined;
    /** Installs and prunes touch the same folder, one at a time. */
    const exclusive = oneAtATime();
    /** `state.json` changes one at a time, each from what the one before left: the page's `ready()` and a daemon coming up meet at start. */
    const stateTurn = oneAtATime();

    const enabled = Boolean(publicKey && feed);

    /** The newest installed bundle that verifies, is not rejected, and this shell can run; otherwise the app's own copy. */
    async function choose(): Promise<RunningBundle> {
        if (!publicKey) return (running = own);

        const state = await readState();

        for (const version of [state.current, state.previous]) {
            if (version === null || version <= own.version || state.rejected.includes(version)) continue;

            const manifest = await installed(version);

            if (manifest) {
                const dir = path.join(bundles, String(version));

                onTrial = state.unconfirmed && version === state.current;

                return (running = {
                    version,
                    rendererRoot: path.join(dir, RENDERER_DIR),
                    dir,
                    rendererFiles: rendererFiles(manifest.files),
                });
            }
        }

        return (running = own);
    }

    /** Starts the ready clock when the running bundle is on its first launch. */
    function watchReady(): void {
        if (onTrial) {
            readyTimer = setTimeout(() => {
                rollBack().catch((error: unknown) =>
                    log(`Could not go back from bundle ${running.version}: ${errorText(error)}`)
                );
            }, options.readyTimeoutMs ?? READY_TIMEOUT_MS);
        }
    }

    /** The running bundle's page rendered: it stays, and the check its trial held back runs. */
    async function ready(): Promise<void> {
        if (!onTrial) return;

        onTrial = false;
        clearTimeout(readyTimer);
        await changeState(state => ({ ...state, unconfirmed: false }));
        check().catch((error: unknown) => log(`The update check failed: ${errorText(error)}`));
    }

    async function rollBack(): Promise<void> {
        if (!onTrial) return;

        onTrial = false;
        await reject('did not start');
        options.relaunch();
    }

    /** Never runs the running bundle again; the next launch runs the one before it. */
    function reject(reason: string): Promise<void> {
        return changeState(state => {
            // Its page and its daemon both failed; the first failure already went back.
            if (state.rejected.includes(running.version)) return state;

            const back = running.version === state.current ? state.previous : null;

            log(`Bundle ${running.version} ${reason}; going back to ${back ?? "the app's own copy"}.`);

            // The previous bundle proves itself again; if it fails too, the app's own copy runs.
            return {
                ...state,
                current: back,
                previous: null,
                unconfirmed: back !== null,
                rejected: [...state.rejected, running.version],
            };
        });
    }

    /** A daemon came up healthy reporting `version`: when that is the running bundle, its daemon is proven. */
    async function daemonUp(version: number | undefined): Promise<void> {
        if (!running.dir || version !== running.version) return;

        await changeState(state =>
            state.proven.includes(version)
                ? state
                : { ...state, proven: [...state.proven, version].slice(-PROVEN_KEPT) }
        );
    }

    /**
     * The running bundle's daemon could not start, and none runs. On the first start of an installed bundle's daemon that
     * rejects the bundle: the database it migrated in this launch comes back from the backup the migration wrote, and the
     * app relaunches on the previous bundle. Resolves true when it relaunches. A bundle whose daemon came up healthy once
     * fixes forward instead.
     */
    function daemonFailed(): Promise<boolean> {
        daemonFailure ??= (async () => {
            if (!running.dir || (await readState()).proven.includes(running.version)) return false;

            onTrial = false;
            clearTimeout(readyTimer);

            // A daemon stuck in its migration still holds the database; it is left alone.
            if (!(await daemonHoldsLock(options.dataDir))) {
                // The bundle goes all the same: its daemon did not start either way.
                const restored = await restoreDatabase(options.dataDir, launchedAt - CLOCK_SLACK_MS).catch(
                    (error: unknown) => {
                        log(
                            `Could not put back the database the daemon of bundle ${running.version} migrated: ${errorText(error)}`
                        );

                        return undefined;
                    }
                );

                if (restored) log(`Put back ${restored}, which the daemon of bundle ${running.version} migrated.`);
            }

            await reject('could not start its daemon');
            options.relaunch();

            return true;
        })();

        return daemonFailure;
    }

    /**
     * Installs the published bundle when it is newer and this shell can run it, for the next launch. Resolves to its
     * version, or null when there is nothing to install (or the running bundle is on trial). Rejects when the feed or
     * the download fails; what is installed stays.
     */
    function check(): Promise<number | null> {
        // A bundle on trial is never replaced: it would escape its rollback, and `previous` would be unproven.
        if (!enabled || onTrial) return Promise.resolve(null);

        checking ??= (async () => {
            // The shell release can hold a newer compatible bundle than the OTA feed immediately after an upgrade.
            // Check it in the background too, so an installed bundle still opens without waiting for the network.
            const version = await installBest({
                onProgress: () => undefined,
                wait: { manifest: (options.catchUpMs ?? CATCH_UP_MS).manifest },
            });

            if (version !== null) {
                installedVersion = version;
                log(`Installed bundle ${version}; it runs from the next launch.`);
                options.onInstalled?.(version);
            }

            return version;
        })().finally(() => {
            checking = undefined;
        });

        return checking;
    }

    /**
     * The first launch of a shell version runs its own copy, which can trail the published bundle by weeks. Installs the
     * published bundle now, so the app opens on it instead of offering a restart a moment later. Offline, refused, or too
     * slow, the app's own copy starts and `check` goes on in the background. Resolves true when a bundle was installed:
     * choose again.
     */
    async function catchUp(onProgress: (fraction: number) => void): Promise<boolean> {
        // An installed bundle is a recent one; `check` keeps it current.
        if (!enabled || running.dir) return false;

        let first = false;

        // Marked first, so a launch cut short does not wait again.
        await changeState(state => {
            first = state.shell !== options.shellVersion;

            return first ? { ...state, shell: options.shellVersion } : state;
        });

        if (!first) return false;

        try {
            const version = await installNewer({ onProgress, wait: options.catchUpMs ?? CATCH_UP_MS });

            if (version !== null) log(`Installed bundle ${version} before the first window.`);

            return version !== null;
        } catch (error) {
            log(`Could not install the newest bundle before the first window: ${errorText(error)}`);

            return false;
        }
    }

    /** Installs the newest usable first bundle from the current feed or this shell's bootstrap. */
    async function bootstrap(onProgress: (fraction: number) => void): Promise<void> {
        if (!publicKey || !feed || !options.bootstrapFeed)
            throw new Error('This app has no update feed or verification key');

        const waiting = { onProgress, wait: options.catchUpMs ?? CATCH_UP_MS };
        if ((await installBest(waiting)) === null) throw new Error('No compatible bundle is available');
    }

    /** Try both sources in version order; a failed source never prevents using the other. */
    async function installBest(waiting: Waiting): Promise<number | null> {
        const errors: Array<{ source: string; message: string }> = [];

        const candidates = await Promise.all(
            [feed, options.bootstrapFeed]
                .filter((source): source is string => Boolean(source))
                .map(async source => {
                    try {
                        return await candidate(source, waiting);
                    } catch (error) {
                        errors.push({ source, message: errorText(error) });
                        return undefined;
                    }
                })
        );

        const usable = candidates.filter(item => item != null).sort((a, b) => b.manifest.version - a.manifest.version);
        for (const item of usable) {
            try {
                await installCandidate(item, waiting);
                return item.manifest.version;
            } catch (error) {
                errors.push({ source: item.source, message: errorText(error) });
            }
        }

        // A healthy current OTA feed is enough when only the supplementary bootstrap is unavailable.
        if (errors.length && !(candidates[0] === null && errors.every(error => error.source !== feed))) {
            throw new Error(errors.map(error => error.message).join('; '));
        }
        return null;
    }

    /**
     * Installs the published bundle when it is newer and this shell can run it, and puts it on trial. Resolves to its
     * version, or null when there is nothing to install. With `waiting` a launch waits, so the requests are cut short.
     */
    async function installNewer(waiting?: Waiting, source = feed): Promise<number | null> {
        const item = await candidate(source, waiting);
        if (!item) return null;
        await installCandidate(item, waiting);
        return item.manifest.version;
    }

    async function candidate(source: string, waiting?: Waiting) {
        const response = await options.fetch(`${source}/${MANIFEST_FILE}`, {
            signal: waiting && AbortSignal.timeout(waiting.wait.manifest),
        });

        // Nothing published yet, or the repository is still private.
        if (response.status === 404) return undefined;

        if (!response.ok) throw new Error(`The bundle manifest answered ${response.status}`);

        const signed = new TextDecoder().decode(await readBody(response, MANIFEST_LIMIT));
        const manifest = openManifest(signed, publicKey);
        const state = await readState();

        if (
            manifest.version <= Math.max(running.version, installedVersion ?? 0) ||
            state.rejected.includes(manifest.version) ||
            !compatible(manifest)
        ) {
            return null;
        }

        return { source, signed, manifest };
    }

    async function installCandidate(
        { source, signed, manifest }: { source: string; signed: string; manifest: BundleManifest },
        waiting?: Waiting
    ): Promise<void> {
        const previous = running.dir ? running.version : null;

        // The state switches in the same turn as the install, so a prune never sees the new folder without the state that keeps it.
        await exclusive(async () => {
            await install(manifest, signed, source, waiting);
            await changeState(state => ({ ...state, current: manifest.version, previous, unconfirmed: true }));
        });
        await prune();
    }

    async function install(manifest: BundleManifest, signed: string, source: string, waiting?: Waiting): Promise<void> {
        const target = path.join(bundles, String(manifest.version));

        // Installed by a run that ended before it wrote `state.json`.
        if (await installed(manifest.version)) return;

        const { name, sha256: archiveHash, size } = manifest.archive;

        // Before the request: a launch whose download stalls before it answers still shows why it waits.
        waiting?.onProgress(0);

        const response = await options.fetch(`${source}/${name}`, {
            signal: waiting?.wait.install === undefined ? undefined : AbortSignal.timeout(waiting.wait.install),
        });

        if (!response.ok) throw new Error(`${name} answered ${response.status}`);

        let received = 0;
        const archive = await readBody(response, size, length => {
            received += length;
            waiting?.onProgress(Math.min(received / size, 1));
        });

        if (archive.length !== size || sha256(archive) !== archiveHash)
            throw new Error(`${name} does not match the manifest`);

        const expected = new Map(Object.entries(manifest.files));
        // The tar `writeTar` makes of the manifest's files: a larger one is not this bundle.
        const limit = tarSize([...expected.values()].map(file => file.size));
        const entries = await gunzipAsync(archive, { maxOutputLength: limit }).then(readTar, (error: unknown) => {
            throw new Error(`${name} does not match the manifest: ${errorText(error)}`);
        });
        const staging = path.join(bundles, `.staging-${manifest.version}-${randomBytes(4).toString('hex')}`);

        try {
            for (const entry of entries) {
                const file = expected.get(entry.path);

                // Only the manifest's paths are written, and those are checked to stay inside the folder.
                if (!file || entry.data.length !== file.size || sha256(entry.data) !== file.sha256) {
                    throw new Error(`${entry.path} in ${name} does not match the manifest`);
                }

                expected.delete(entry.path);
                await mkdir(path.dirname(path.join(staging, entry.path)), { recursive: true });
                await writeFile(path.join(staging, entry.path), entry.data);
            }

            const [missing] = expected.keys();

            if (missing !== undefined) throw new Error(`${name} lacks ${missing}`);

            await writeFile(path.join(staging, MANIFEST_FILE), signed);
            await rm(target, { recursive: true, force: true });
            await renameWhenFree(staging, target);
        } finally {
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
                const results = await Promise.all(
                    files.slice(start, start + HASHES_AT_ONCE).map(async ([file, expected]) => {
                        const bytes = await readFile(path.join(dir, file));

                        return bytes.length === expected.size && sha256(bytes) === expected.sha256;
                    })
                );

                if (results.includes(false)) return null;
            }

            return manifest;
        } catch {
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
            } catch (error) {
                log(`Not deleting old bundles now: ${errorText(error)}`);

                return;
            }

            const state = await readState();
            const keep = new Set([state.current, state.previous, own.version, running.version, daemon].map(String));

            for (const entry of await readdir(bundles).catch(() => [] as string[])) {
                if (keep.has(entry)) continue;

                // Windows refuses to delete a file that is open; the next prune tries again.
                await rm(path.join(bundles, entry), { recursive: true, force: true }).catch((error: unknown) =>
                    log(`Could not delete ${entry}: ${errorText(error)}`)
                );
            }
        });
    }

    async function readState(): Promise<OtaState> {
        try {
            const state = JSON.parse(await readFile(path.join(updates, STATE_FILE), 'utf8')) as Partial<OtaState>;
            const version = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : null);

            return {
                current: version(state.current),
                previous: version(state.previous),
                unconfirmed: state.unconfirmed === true,
                rejected: Array.isArray(state.rejected) ? state.rejected.filter(Number.isSafeInteger) : [],
                proven: Array.isArray(state.proven) ? state.proven.filter(Number.isSafeInteger) : [],
                shell: typeof state.shell === 'string' ? state.shell : null,
            };
        } catch {
            return NO_STATE;
        }
    }

    /** Writes what `change` makes of the state; one rename switches it, so a crash leaves the old state or the new one. */
    function changeState(change: (state: OtaState) => OtaState): Promise<void> {
        return stateTurn(async () => {
            const state = await readState();
            const next = change(state);

            if (next === state) return;

            const file = path.join(updates, STATE_FILE);

            await mkdir(updates, { recursive: true });
            await writeFile(`${file}.tmp`, JSON.stringify(next));
            await rename(`${file}.tmp`, file);
        });
    }

    /** Restarts into the installed bundle; nothing installed, nothing happens. */
    function restart(): void {
        if (installedVersion !== null) options.relaunch();
    }

    return {
        enabled,
        choose,
        catchUp,
        bootstrap,
        watchReady,
        ready,
        daemonUp,
        daemonFailed,
        check,
        prune,
        restart,
        pending: () => installedVersion,
    };
}

/** Runs each piece of work it is given once the one before has settled. */
function oneAtATime() {
    let last: Promise<unknown> = Promise.resolve();

    return <T>(work: () => Promise<T>): Promise<T> => {
        const result = last.then(work);

        last = result.catch(() => undefined);

        return result;
    };
}

/** The body, refused past `limit` bytes, so a hostile host cannot exhaust memory with an endless one. */
async function readBody(response: Response, limit: number, onChunk?: (length: number) => void): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let length = 0;

    for await (const chunk of response.body ?? []) {
        length += chunk.length;

        // Leaving the loop cancels the download.
        if (length > limit) throw new Error(`${response.url || 'A download'} is larger than ${limit} bytes`);

        chunks.push(chunk);
        onChunk?.(chunk.length);
    }

    return Buffer.concat(chunks);
}
