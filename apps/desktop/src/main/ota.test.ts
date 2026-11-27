import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type BundleManifest, MANIFEST_FILE, sha256, signManifest } from './bundleManifest';
import { createOta, type RunningBundle } from './ota';
import { writeTar } from './tar';

const keyPair = () =>
    generateKeyPairSync('ed25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
const release = keyPair();
const stranger = keyPair();
const FEED = 'https://feed.test/ota';
const BOOTSTRAP = 'https://feed.test/v0.2.0';
const PROTOCOL = 3;
const encoder = new TextEncoder();

let base: string;

beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'clowdy-ota-'));
});

afterEach(async () => {
    vi.useRealTimers();
    await rm(base, { recursive: true, force: true });
});

const bundleFiles = (version: number): Record<string, string> => ({
    'renderer/index.html': `page ${version}`,
    'renderer/assets/app.js': `app ${version}`,
    'daemon/main.js': `daemon ${version}`,
    'system-skills/skills/plan/SKILL.md': `skill ${version}`,
});

interface Publish {
    source?: string;
    minShell?: string;
    protocol?: number;
    key?: string;
    /** Changes the archive's files after the manifest describes them. */
    alter?: (files: Record<string, string>) => Record<string, string>;
    /** Changes the archive's bytes after the manifest describes them. */
    corrupt?: boolean;
}

/** One machine: the updates folder, the feed it checks, and the app's own copy. */
function machine({ ownVersion = 100, shellVersion = '0.2.0', catchUpMs = { manifest: 3000, install: 60_000 } } = {}) {
    const updates = path.join(base, 'updates');
    const dataDir = path.join(base, 'daemon');
    const feed = new Map<string, Uint8Array>();
    const fetch = vi.fn(async (url: string, _init?: { signal?: AbortSignal }) => {
        const body = feed.get(url);

        return body ? new Response(Buffer.from(body)) : new Response(null, { status: 404 });
    });
    const relaunch = vi.fn();
    const onInstalled = vi.fn();
    let daemonVersion: number | undefined | Error;
    const own: RunningBundle = {
        version: ownVersion,
        rendererRoot: path.join(base, 'app/renderer'),
        dir: null,
        rendererFiles: null,
    };

    return {
        updates,
        dataDir,
        fetch,
        relaunch,
        onInstalled,
        own,
        setDaemonVersion: (version: number | undefined | Error) => {
            daemonVersion = version;
        },
        /** A new process of the app. */
        launch: async () => {
            const ota = createOta({
                updates,
                dataDir,
                own,
                shellVersion,
                protocol: PROTOCOL,
                publicKey: release.publicKey,
                feed: FEED,
                bootstrapFeed: BOOTSTRAP,
                fetch,
                daemonVersion: async () => {
                    if (daemonVersion instanceof Error) throw daemonVersion;

                    return daemonVersion;
                },
                relaunch,
                onInstalled,
                readyTimeoutMs: 20,
                catchUpMs,
            });

            return { ota, bundle: await ota.choose() };
        },
        /** What `publish-ota.ts` leaves in the `ota` release. */
        publish(
            version: number,
            {
                minShell = '0.1.0',
                protocol = PROTOCOL,
                key = release.privateKey,
                alter = files => files,
                corrupt = false,
                source = FEED,
            }: Publish = {}
        ) {
            const files = bundleFiles(version);
            const archive = gzipSync(
                writeTar(
                    Object.entries(alter(files)).map(([file, text]) => ({ path: file, data: encoder.encode(text) }))
                )
            );
            const name = `bundle-${version}.tar.gz`;
            const manifest: BundleManifest = {
                version,
                minShell,
                protocol,
                archive: { name, sha256: sha256(archive), size: archive.length },
                files: Object.fromEntries(
                    Object.entries(files).map(([file, text]) => [
                        file,
                        { sha256: sha256(encoder.encode(text)), size: encoder.encode(text).length },
                    ])
                ),
            };

            if (corrupt) archive[archive.length - 1] ^= 0xff;

            feed.set(`${source}/${name}`, archive);
            feed.set(`${source}/manifest.json`, encoder.encode(JSON.stringify(signManifest(manifest, key))));
        },
        installed: async () => (await readdir(path.join(updates, 'bundles')).catch(() => [] as string[])).sort(),
        state: async () =>
            JSON.parse(await readFile(path.join(updates, 'state.json'), 'utf8')) as Record<string, unknown>,
    };
}

type Machine = ReturnType<typeof machine>;

/** Installs `version` and confirms it on its first launch. */
async function installAndConfirm(app: Machine, version: number) {
    app.publish(version);
    await (await app.launch()).ota.check();

    const next = await app.launch();

    next.ota.watchReady();
    await next.ota.ready();
    // The check that `ready()` lets through.
    await next.ota.check();

    return next;
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('choose', () => {
    test("runs the app's own copy when nothing is installed", async () => {
        const app = machine();

        expect((await app.launch()).bundle).toBe(app.own);
    });

    test("runs an installed bundle from its folder, with its renderer's hashes", async () => {
        const app = machine();

        app.publish(101);
        await (await app.launch()).ota.check();

        const { bundle } = await app.launch();
        const dir = path.join(app.updates, 'bundles/101');

        expect(bundle).toMatchObject({ version: 101, dir, rendererRoot: path.join(dir, 'renderer') });
        expect(Object.keys(bundle.rendererFiles ?? {}).sort()).toEqual(['assets/app.js', 'index.html']);
    });

    test('skips an installed bundle with an altered file', async () => {
        const app = machine();

        await installAndConfirm(app, 101);
        await writeFile(path.join(app.updates, 'bundles/101/daemon/main.js'), 'altered');

        expect((await app.launch()).bundle).toBe(app.own);
    });

    test("skips an installed bundle that is not newer than the app's own copy", async () => {
        const app = machine();

        await installAndConfirm(app, 101);

        const newerShell = machine({ ownVersion: 120 });

        expect((await newerShell.launch()).bundle).toBe(newerShell.own);
    });
});

describe('check', () => {
    test('installs a newer bundle for the next launch', async () => {
        const app = machine();
        const { ota } = await app.launch();

        app.publish(101);

        await expect(ota.check()).resolves.toBe(101);
        expect(ota.pending()).toBe(101);
        expect(app.onInstalled).toHaveBeenCalledWith(101);
        expect(await app.installed()).toEqual(['101']);
        expect(await app.state()).toEqual({
            current: 101,
            previous: null,
            unconfirmed: true,
            rejected: [],
            proven: [],
            shell: null,
        });
        expect(await readFile(path.join(app.updates, 'bundles/101/renderer/index.html'), 'utf8')).toBe('page 101');
        expect(JSON.parse(await readFile(path.join(app.updates, 'bundles/101', MANIFEST_FILE), 'utf8'))).toHaveProperty(
            'signature'
        );
    });

    test('keeps the running installed bundle as the one to go back to', async () => {
        const app = machine();
        const { ota } = await installAndConfirm(app, 101);

        app.publish(102);
        await ota.check();

        expect(await app.state()).toMatchObject({ current: 102, previous: 101, unconfirmed: true });
        expect(await app.installed()).toEqual(['101', '102']);
    });

    test('finds nothing when the feed has no manifest', async () => {
        const app = machine();

        await expect((await app.launch()).ota.check()).resolves.toBeNull();
        expect(await app.installed()).toEqual([]);
    });

    test('ignores a bundle that is not newer, needs a newer shell, speaks another protocol, or was rejected', async () => {
        const app = machine();
        const { ota } = await app.launch();

        app.publish(100);
        await expect(ota.check()).resolves.toBeNull();

        app.publish(101, { minShell: '0.3.0' });
        await expect(ota.check()).resolves.toBeNull();

        app.publish(101, { protocol: PROTOCOL + 1 });
        await expect(ota.check()).resolves.toBeNull();

        await mkdir(app.updates, { recursive: true });
        await writeFile(
            path.join(app.updates, 'state.json'),
            JSON.stringify({ current: null, previous: null, unconfirmed: false, rejected: [102] })
        );
        app.publish(102);
        await expect(ota.check()).resolves.toBeNull();

        expect(await app.installed()).toEqual([]);
    });

    test('refuses a manifest signed by another key', async () => {
        const app = machine();
        const { ota } = await app.launch();

        app.publish(101, { key: stranger.privateKey });

        await expect(ota.check()).rejects.toThrow(/not signed by the release key/);
        expect(await app.installed()).toEqual([]);
    });

    test('refuses an archive that does not match the manifest', async () => {
        const app = machine();
        const { ota } = await app.launch();

        app.publish(101, { corrupt: true });

        await expect(ota.check()).rejects.toThrow(/does not match the manifest/);
        expect(await app.installed()).toEqual([]);
    });

    test('refuses an archive with an altered, extra, or missing file, and leaves no partial folder', async () => {
        const app = machine();
        const { ota } = await app.launch();

        app.publish(101, { alter: files => ({ ...files, 'daemon/main.js': 'altered' }) });
        await expect(ota.check()).rejects.toThrow(/daemon\/main\.js .* does not match/);

        app.publish(101, { alter: files => ({ ...files, 'daemon/extra.js': 'extra' }) });
        // Larger than the files the manifest lists, it is refused while it unpacks.
        await expect(ota.check()).rejects.toThrow(/does not match the manifest/);

        app.publish(101, { alter: ({ 'daemon/main.js': _dropped, ...files }) => files });
        await expect(ota.check()).rejects.toThrow(/lacks daemon\/main\.js/);

        expect(await app.installed()).toEqual([]);
    });

    test('does not replace a bundle on its first launch until it is ready', async () => {
        const app = machine();

        app.publish(101);
        await (await app.launch()).ota.check();

        const { ota } = await app.launch();

        app.publish(102);
        app.fetch.mockClear();
        await expect(ota.check()).resolves.toBeNull();
        expect(app.fetch).not.toHaveBeenCalled();
    });

    test('is off without a feed', async () => {
        const app = machine();
        const ota = createOta({
            updates: app.updates,
            dataDir: app.dataDir,
            own: app.own,
            shellVersion: '0.2.0',
            protocol: PROTOCOL,
            publicKey: release.publicKey,
            feed: '',
            fetch: app.fetch,
            daemonVersion: async () => undefined,
            relaunch: app.relaunch,
        });

        expect(ota.enabled).toBe(false);
        await expect(ota.check()).resolves.toBeNull();
        expect(app.fetch).not.toHaveBeenCalled();
    });
});

describe('shell upgrade with a cached bundle', () => {
    async function upgraded() {
        await installAndConfirm(machine({ ownVersion: 0, shellVersion: '0.1.2' }), 101);
        const app = machine({ ownVersion: 0, shellVersion: '0.1.3' });
        app.publish(101);
        app.publish(102, { source: BOOTSTRAP });
        return app;
    }

    test('opens the cache and installs the newer shell bootstrap for restart', async () => {
        const app = await upgraded();
        const { ota, bundle } = await app.launch();
        expect(bundle.version).toBe(101);
        await expect(ota.check()).resolves.toBe(102);
        expect(await app.state()).toMatchObject({ current: 102, previous: 101, unconfirmed: true });
        expect((await app.launch()).bundle.version).toBe(102);
    });

    test('selects a newer compatible OTA over the bootstrap', async () => {
        const app = await upgraded();
        app.publish(103);
        const { ota } = await app.launch();
        await expect(ota.check()).resolves.toBe(103);
        expect((await app.launch()).bundle.version).toBe(103);
    });

    test('keeps the cache usable offline and retries the bootstrap on a later check', async () => {
        const app = await upgraded();
        const serve = app.fetch.getMockImplementation()!;
        app.fetch.mockRejectedValue(new Error('offline'));
        const { ota, bundle } = await app.launch();
        expect(bundle.version).toBe(101);
        await expect(ota.check()).rejects.toThrow('offline');
        expect((await app.launch()).bundle.version).toBe(101);
        app.fetch.mockImplementation(serve);
        await expect(ota.check()).resolves.toBe(102);
    });

    test('uses a newer OTA when the bootstrap is inaccessible', async () => {
        const app = await upgraded();
        const serve = app.fetch.getMockImplementation()!;
        app.publish(103);
        app.fetch.mockImplementation((url, init) =>
            url.startsWith(BOOTSTRAP) ? Promise.reject(new Error('unavailable')) : serve(url, init)
        );
        const { ota } = await app.launch();
        await expect(ota.check()).resolves.toBe(103);
    });

    test('reports no update when the current OTA is healthy and bootstrap is inaccessible', async () => {
        const app = await upgraded();
        const serve = app.fetch.getMockImplementation()!;
        app.fetch.mockImplementation((url, init) =>
            url.startsWith(BOOTSTRAP) ? Promise.reject(new Error('unavailable')) : serve(url, init)
        );
        const { ota } = await app.launch();
        await expect(ota.check()).resolves.toBeNull();
        expect((await app.launch()).bundle.version).toBe(101);
    });

    test('reports a broken OTA even when the bootstrap is already installed', async () => {
        const app = await upgraded();
        app.publish(101, { source: BOOTSTRAP });
        app.publish(103, { key: stranger.privateKey });
        const { ota } = await app.launch();
        await expect(ota.check()).rejects.toThrow(/not signed by the release key/);
    });

    test.each<Publish>([{ minShell: '0.3.0' }, { protocol: 4 }, { key: stranger.privateKey }, { corrupt: true }])(
        'does not replace the cache with an unusable bootstrap: %o',
        async invalid => {
            const app = await upgraded();
            app.publish(102, { ...invalid, source: BOOTSTRAP });
            const { ota } = await app.launch();
            await ota.check().catch(() => null);
            expect((await app.launch()).bundle.version).toBe(101);
            expect(app.relaunch).not.toHaveBeenCalled();
        }
    );

    test('keeps an interrupted trial until it fails and then rejects it without a restart loop', async () => {
        const app = await upgraded();
        await (await app.launch()).ota.check();
        const interrupted = await app.launch();
        expect(interrupted.bundle.version).toBe(102);
        await expect(interrupted.ota.check()).resolves.toBeNull();

        const trial = await app.launch();
        trial.ota.watchReady();
        await vi.waitFor(() => expect(app.relaunch).toHaveBeenCalledOnce());
        const previous = await app.launch();
        expect(previous.bundle.version).toBe(101);
        await previous.ota.ready();
        await expect(previous.ota.check()).resolves.toBeNull();
        expect((await app.launch()).bundle.version).toBe(101);
        expect(app.relaunch).toHaveBeenCalledOnce();
    });
});

describe('trial', () => {
    test('a bundle that is ready stays', async () => {
        const app = machine();

        await installAndConfirm(app, 101);
        await wait(40);

        expect(app.relaunch).not.toHaveBeenCalled();
        expect(await app.state()).toMatchObject({ current: 101, unconfirmed: false });
        expect((await app.launch()).bundle.version).toBe(101);
    });

    test('a bundle that is not ready in time is rejected, and the previous one runs', async () => {
        const app = machine();

        await installAndConfirm(app, 101);
        app.publish(102);
        await (await app.launch()).ota.check();

        const { ota, bundle } = await app.launch();

        expect(bundle.version).toBe(102);
        ota.watchReady();
        await vi.waitFor(() => expect(app.relaunch).toHaveBeenCalledOnce());

        expect(await app.state()).toEqual({
            current: 101,
            previous: null,
            unconfirmed: true,
            rejected: [102],
            proven: [],
            shell: null,
        });

        const back = await app.launch();

        expect(back.bundle.version).toBe(101);

        // Still published, the rejected bundle is not installed again.
        await back.ota.ready();
        await expect(back.ota.check()).resolves.toBeNull();
        expect(await app.installed()).toEqual(['101', '102']);
    });

    test("a bundle installed over the app's own copy goes back to it", async () => {
        const app = machine();

        app.publish(101);
        await (await app.launch()).ota.check();
        (await app.launch()).ota.watchReady();
        await vi.waitFor(() => expect(app.relaunch).toHaveBeenCalledOnce());

        expect(await app.state()).toEqual({
            current: null,
            previous: null,
            unconfirmed: false,
            rejected: [101],
            proven: [],
            shell: null,
        });
        expect((await app.launch()).bundle).toBe(app.own);
    });

    test("the app's own copy needs no trial", async () => {
        const app = machine();
        const { ota } = await app.launch();

        ota.watchReady();
        await wait(40);

        expect(app.relaunch).not.toHaveBeenCalled();
    });
});

describe('daemon trial', () => {
    /** The data folder after a daemon of this launch migrated the database from schema 3 to 4 and then died. */
    async function migratedAndDied(app: Machine) {
        await mkdir(app.dataDir, { recursive: true });
        await writeFile(path.join(app.dataDir, 'clowdy.db.bak-v3'), 'schema 3');
        await writeFile(path.join(app.dataDir, 'clowdy.db'), 'schema 4');
        await writeFile(path.join(app.dataDir, 'clowdy.db-wal'), 'schema 4 pages');
    }

    const database = (app: Machine) => readFile(path.join(app.dataDir, 'clowdy.db'), 'utf8');

    test('a bundle whose daemon fails its first start is rejected, with the database it migrated put back', async () => {
        const app = machine();

        await installAndConfirm(app, 101);
        app.publish(102);
        await (await app.launch()).ota.check();

        const { ota } = await app.launch();

        await migratedAndDied(app);

        await expect(ota.daemonFailed()).resolves.toBe(true);
        expect(app.relaunch).toHaveBeenCalledOnce();
        expect(await database(app)).toBe('schema 3');
        expect(await app.state()).toMatchObject({ current: 101, previous: null, unconfirmed: true, rejected: [102] });
        // Asked again (the keeper and the start both report it), it relaunches once.
        await expect(ota.daemonFailed()).resolves.toBe(true);
        expect(app.relaunch).toHaveBeenCalledOnce();
    });

    test('a daemon that fails after the page did goes back only once', async () => {
        const app = machine();

        await installAndConfirm(app, 101);
        app.publish(102);
        await (await app.launch()).ota.check();

        const { ota } = await app.launch();

        ota.watchReady();
        await vi.waitFor(() => expect(app.relaunch).toHaveBeenCalledOnce());
        await ota.daemonFailed();

        expect(await app.state()).toMatchObject({ current: 101, previous: null, rejected: [102] });
    });

    test('a database that cannot be put back does not keep the bundle', async () => {
        const app = machine();

        app.publish(101);
        await (await app.launch()).ota.check();

        const { ota } = await app.launch();

        await migratedAndDied(app);
        await mkdir(path.join(app.dataDir, 'clowdy.db.restoring'));

        await expect(ota.daemonFailed()).resolves.toBe(true);
        expect(app.relaunch).toHaveBeenCalledOnce();
        expect(await database(app)).toBe('schema 4');
        expect(await app.state()).toMatchObject({ current: null, rejected: [101] });
    });

    test('a daemon that came up once is not rolled back later', async () => {
        const app = machine();
        const { ota } = await installAndConfirm(app, 101);

        await ota.daemonUp(101);
        await migratedAndDied(app);

        await expect(ota.daemonFailed()).resolves.toBe(false);
        expect(app.relaunch).not.toHaveBeenCalled();
        expect(await database(app)).toBe('schema 4');
        expect(await app.state()).toMatchObject({ current: 101, rejected: [], proven: [101] });
    });

    test('a daemon that comes up while the page reports ready proves the bundle, and the page confirms it', async () => {
        const app = machine();

        app.publish(101);
        await (await app.launch()).ota.check();

        const { ota } = await app.launch();

        ota.watchReady();
        await Promise.all([ota.ready(), ota.daemonUp(101)]);

        expect(await app.state()).toMatchObject({ current: 101, unconfirmed: false, proven: [101] });
    });

    test("only the running bundle's daemon proves it", async () => {
        const app = machine();
        const { ota } = await installAndConfirm(app, 101);

        await ota.daemonUp(100);
        await ota.daemonUp(undefined);

        expect(await app.state()).toMatchObject({ proven: [], shell: null });
    });

    test('a database a live daemon still holds is left alone, and the bundle is rejected all the same', async () => {
        const app = machine();

        app.publish(101);
        await (await app.launch()).ota.check();

        const { ota } = await app.launch();

        await migratedAndDied(app);
        await writeFile(path.join(app.dataDir, 'daemon.lock'), String(process.pid));

        await expect(ota.daemonFailed()).resolves.toBe(true);
        expect(await database(app)).toBe('schema 4');
        expect(await app.state()).toMatchObject({ current: null, rejected: [101] });
    });

    test("the app's own copy has no daemon trial", async () => {
        const app = machine();
        const { ota } = await app.launch();

        await expect(ota.daemonFailed()).resolves.toBe(false);
        expect(app.relaunch).not.toHaveBeenCalled();
    });
});

/** A request that hangs until it is aborted, as one on a blackholed network does. */
const hangs = (init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });

describe('bootstrap', () => {
    test('installs a signed bundle from a local HTTP server', async () => {
        const app = machine({ ownVersion: 0 });
        app.publish(101, { source: BOOTSTRAP });
        const serve = app.fetch.getMockImplementation()!;
        const server = createServer(async (request, response) => {
            const original = `https://feed.test${request.url}`;
            const file = await serve(original);
            response.writeHead(file.status);
            response.end(Buffer.from(await file.arrayBuffer()));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('No HTTP address');
        app.fetch.mockImplementation((url, init) =>
            globalThis.fetch(url.replace('https://feed.test', `http://127.0.0.1:${address.port}`), init)
        );

        try {
            const { ota } = await app.launch();
            await ota.bootstrap(vi.fn());
            expect((await ota.choose()).version).toBe(101);
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        }
    });

    test('prefers the latest compatible bundle and uses it offline on later launches', async () => {
        const app = machine({ ownVersion: 0 });
        app.publish(101, { source: BOOTSTRAP });
        app.publish(102);
        const { ota } = await app.launch();
        const progress = vi.fn();

        await ota.bootstrap(progress);
        expect((await ota.choose()).version).toBe(102);
        expect(progress).toHaveBeenCalledWith(1);
        app.fetch.mockRejectedValue(new Error('offline'));
        expect((await app.launch()).bundle.version).toBe(102);
    });

    test('prefers the newer bootstrap when the latest feed has an older compatible bundle', async () => {
        const app = machine({ ownVersion: 0 });
        app.publish(102, { source: BOOTSTRAP });
        app.publish(101);
        const { ota } = await app.launch();

        await ota.bootstrap(vi.fn());
        expect((await ota.choose()).version).toBe(102);
    });

    test('tries the older compatible source when the newest archive is corrupt', async () => {
        const app = machine({ ownVersion: 0 });
        app.publish(102, { source: BOOTSTRAP, corrupt: true });
        app.publish(101);
        const { ota } = await app.launch();

        await ota.bootstrap(vi.fn());
        expect((await ota.choose()).version).toBe(101);
    });

    test.each<Publish>([{ minShell: '0.3.0' }, { protocol: 4 }, { key: stranger.privateKey }, { corrupt: true }])(
        'uses the signed compatible fallback when the latest feed cannot be used: %o',
        async latest => {
            const app = machine({ ownVersion: 0 });
            app.publish(101, { source: BOOTSTRAP });
            app.publish(102, latest);
            const { ota } = await app.launch();

            await ota.bootstrap(vi.fn());
            expect((await ota.choose()).version).toBe(101);
        }
    );

    test('fails offline and succeeds on retry after connectivity returns', async () => {
        const app = machine({ ownVersion: 0 });
        app.publish(101, { source: BOOTSTRAP });
        const serve = app.fetch.getMockImplementation()!;
        app.fetch.mockRejectedValue(new Error('offline'));
        const { ota } = await app.launch();

        await expect(ota.bootstrap(vi.fn())).rejects.toThrow();
        app.fetch.mockImplementation(serve);
        await ota.bootstrap(vi.fn());
        expect((await ota.choose()).version).toBe(101);
    });

    test('rejects a tampered fallback and leaves no installed bundle', async () => {
        const app = machine({ ownVersion: 0 });
        app.publish(101, { source: BOOTSTRAP, corrupt: true });
        const { ota } = await app.launch();

        await expect(ota.bootstrap(vi.fn())).rejects.toThrow();
        expect(await app.installed()).toEqual([]);
    });

    test('uses the fallback after the first downloaded bundle fails its trial', async () => {
        const app = machine({ ownVersion: 0 });
        app.publish(101, { source: BOOTSTRAP });
        app.publish(102);
        const first = await app.launch();
        await first.ota.bootstrap(vi.fn());
        await first.ota.choose();
        first.ota.watchReady();
        await vi.waitFor(() => expect(app.relaunch).toHaveBeenCalledOnce());

        const next = await app.launch();
        await next.ota.bootstrap(vi.fn());
        expect((await next.ota.choose()).version).toBe(101);
    });
});

describe('catchUp', () => {
    /** A first launch: the bundle is chosen, then the catch-up runs and chooses again when it installed one. */
    async function firstLaunch(app: Machine) {
        const { ota } = await app.launch();
        const progress = vi.fn();
        const installed = await ota.catchUp(progress);

        return { ota, installed, progress, bundle: installed ? await ota.choose() : null };
    }

    test('installs the published bundle before the first window and runs it on trial', async () => {
        const app = machine();

        app.publish(101);

        const { ota, installed, progress, bundle } = await firstLaunch(app);

        expect(installed).toBe(true);
        expect(bundle).toMatchObject({ version: 101, dir: path.join(app.updates, 'bundles/101') });
        expect(progress.mock.calls[0]).toEqual([0]);
        expect(progress.mock.lastCall).toEqual([1]);
        // It runs now, so nothing waits for a restart.
        expect(app.onInstalled).not.toHaveBeenCalled();
        expect(ota.pending()).toBeNull();

        // A renderer that never gets ready is rolled back to the app's own copy, as any other.
        ota.watchReady();
        await vi.waitFor(() => expect(app.relaunch).toHaveBeenCalledOnce());
        expect((await app.launch()).bundle).toBe(app.own);
    });

    test('waits only on the first launch of a shell version', async () => {
        const app = machine();

        app.publish(101);
        await firstLaunch(app);
        app.fetch.mockClear();

        await expect((await app.launch()).ota.catchUp(vi.fn())).resolves.toBe(false);
        expect(app.fetch).not.toHaveBeenCalled();

        // A new shell version waits again, whatever the last one saw.
        const updated = machine({ ownVersion: 110, shellVersion: '0.2.1' });

        updated.publish(111);
        expect((await firstLaunch(updated)).bundle?.version).toBe(111);
    });

    test('leaves an installed bundle to the background check', async () => {
        const app = machine();

        await installAndConfirm(app, 101);
        app.publish(102);
        app.fetch.mockClear();

        expect((await firstLaunch(app)).installed).toBe(false);
        expect(app.fetch).not.toHaveBeenCalled();
    });

    test.each<[string, number, Publish]>([
        ["nothing newer than the app's own copy", 100, {}],
        ['a bundle for a newer shell', 101, { minShell: '0.3.0' }],
        ['a manifest signed with another key', 101, { key: stranger.privateKey }],
        ['an archive that does not match', 101, { corrupt: true }],
    ])("starts the app's own copy for %s, and does not wait again", async (_name, version, published) => {
        const app = machine();

        app.publish(version, published);

        expect((await firstLaunch(app)).installed).toBe(false);
        expect(await app.installed()).toEqual([]);
        await expect((await app.launch()).ota.catchUp(vi.fn())).resolves.toBe(false);
    });

    test("starts the app's own copy when the feed is down, then installs in the background", async () => {
        const app = machine();
        const serve = app.fetch.getMockImplementation()!;

        app.fetch.mockRejectedValue(new TypeError('fetch failed'));

        const { ota, installed, progress } = await firstLaunch(app);

        expect(installed).toBe(false);
        expect(progress).not.toHaveBeenCalled();

        app.fetch.mockImplementation(serve);
        app.publish(101);
        await ota.check();

        expect(ota.pending()).toBe(101);
    });

    test('gives up on a feed that does not answer', async () => {
        const app = machine({ catchUpMs: { manifest: 20, install: 20 } });

        app.fetch.mockImplementation((_url, init) => hangs(init));

        expect((await firstLaunch(app)).installed).toBe(false);
    });

    test('gives up on a download that stalls, and leaves nothing behind', async () => {
        const app = machine({ catchUpMs: { manifest: 1000, install: 20 } });
        const serve = app.fetch.getMockImplementation()!;

        app.publish(101);
        app.fetch.mockImplementation((url, init) => (url.endsWith('.tar.gz') ? hangs(init) : serve(url)));

        const { installed, progress } = await firstLaunch(app);

        expect(installed).toBe(false);
        // The boot window showed while it waited.
        expect(progress).toHaveBeenCalledWith(0);
        expect(await app.installed()).toEqual([]);
    });
});

describe('prune', () => {
    test("keeps the choices, the own copy, and the running daemon's bundle", async () => {
        const app = machine();
        const bundles = path.join(app.updates, 'bundles');

        for (const leftover of ['90', '95', '100', '.staging-99-abcd', '100.tmp-1234'])
            await mkdir(path.join(bundles, leftover), { recursive: true });

        app.setDaemonVersion(95);
        await installAndConfirm(app, 101);

        const { ota } = await installAndConfirm(app, 102);

        await ota.prune();

        expect(await app.installed()).toEqual(['100', '101', '102', '95']);
    });

    test('deletes nothing while a daemon runs that does not say which bundle it is', async () => {
        const app = machine();

        await mkdir(path.join(app.updates, 'bundles/90'), { recursive: true });
        app.setDaemonVersion(new Error('The daemon holds its lock but does not answer'));

        const { ota } = await app.launch();

        await ota.prune();

        expect(await app.installed()).toEqual(['90']);
    });

    test('a prune asked for during a download keeps the bundle it installs', async () => {
        const app = machine();
        const { ota } = await app.launch();
        const serve = app.fetch.getMockImplementation()!;
        const download = Promise.withResolvers<void>();

        app.fetch.mockImplementation(async url => {
            if (url.endsWith('.tar.gz')) await download.promise;

            return serve(url);
        });
        app.publish(101);

        const installing = ota.check();

        await vi.waitFor(() => expect(app.fetch).toHaveBeenCalledTimes(2));

        // The daemon was replaced meanwhile (`startKeeper`'s clean-up).
        const pruning = ota.prune();

        download.resolve();
        await Promise.all([installing, pruning]);

        expect(await app.installed()).toEqual(['101']);
        expect((await app.launch()).bundle.version).toBe(101);
    });
});

test('restart relaunches only into an installed bundle', async () => {
    const app = machine();
    const { ota } = await app.launch();

    ota.restart();
    expect(app.relaunch).not.toHaveBeenCalled();

    app.publish(101);
    await ota.check();
    ota.restart();
    expect(app.relaunch).toHaveBeenCalledOnce();
});
