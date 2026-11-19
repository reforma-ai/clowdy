/**
 * A local OTA feed, to try updates in a development run before the repository is public: builds a bundle of this
 * checkout, signs it with a test key, and serves `manifest.json` and the archive on 127.0.0.1. The key stays in
 * `.ota-local/`, so the app keeps trusting the feed across runs.
 *
 *   bun scripts/ota-local.ts [--version <n>] [--no-ready] [--broken-daemon] [--port <n>]
 *
 *   --version   the bundle's number, this commit's by default; serve a higher one to try the next update
 *   --no-ready       a renderer that never calls `ready()`, to try the rollback
 *   --broken-daemon  a daemon that exits at once, to try the rollback of a daemon's first start
 *
 * Then start the app with the command it prints.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { MANIFEST_FILE, RENDERER_DIR, signManifest } from '../src/main/bundleManifest';
import { bundleInfo, layoutOtaBundle, packOtaBundle } from './bundle';

const home = path.resolve(import.meta.dir, '../.ota-local');
/** `./clowdy` at the repository root, which this script is not run from. */
const launcher = path.resolve(import.meta.dir, '../../../clowdy');
const NOT_READY_PAGE = '<!doctype html><title>Clowdy</title><p>This renderer never calls ready()</p>';
const BROKEN_DAEMON = 'console.error(\'This daemon never starts\');\nprocess.exit(1);\n';

const { values } = parseArgs({
    options: {
        version: { type: 'string' },
        'no-ready': { type: 'boolean', default: false },
        'broken-daemon': { type: 'boolean', default: false },
        port: { type: 'string', default: '4789' },
    },
});

/** The test key pair, made on the first run. */
async function testKeys(): Promise<{ privateKey: string; publicKey: string; publicPath: string }> {
    const privatePath = path.join(home, 'private.pem');
    const publicPath = path.join(home, 'public.pem');

    try {
        return { privateKey: await readFile(privatePath, 'utf8'), publicKey: await readFile(publicPath, 'utf8'), publicPath };
    }
    catch {
        const keys = generateKeyPairSync('ed25519', {
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            publicKeyEncoding: { type: 'spki', format: 'pem' },
        });

        await mkdir(home, { recursive: true });
        await writeFile(privatePath, keys.privateKey, { mode: 0o600 });
        await writeFile(publicPath, keys.publicKey);

        return { ...keys, publicPath };
    }
}

const info = await bundleInfo();
const version = values.version === undefined ? info.version : Number(values.version);

if (!Number.isSafeInteger(version) || version <= 0) throw new Error(`--version wants a positive whole number, not ${ values.version }`);

const port = Number(values.port);
const feed = path.join(home, 'feed');
const folder = path.join(feed, 'bundle');
const bundle = { ...info, version };

await layoutOtaBundle(folder, bundle);

if (values['no-ready']) await writeFile(path.join(folder, RENDERER_DIR, 'index.html'), NOT_READY_PAGE);

if (values['broken-daemon']) await writeFile(path.join(folder, 'daemon/main.js'), BROKEN_DAEMON);

const { manifest, archive } = await packOtaBundle(folder, feed, bundle);
const { privateKey, publicPath } = await testKeys();
const signed = JSON.stringify(signManifest(manifest, privateKey));

Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(request) {
        const { pathname } = new URL(request.url);

        console.info(`${ request.method } ${ pathname }`);

        if (pathname === `/${ MANIFEST_FILE }`) return new Response(signed, { headers: { 'content-type': 'application/json' } });

        if (pathname === `/${ manifest.archive.name }`) return new Response(Bun.file(archive));

        return new Response('Not found', { status: 404 });
    },
});

console.info(`Serving bundle ${ version }${ values['no-ready'] ? ' (never ready)' : '' }${ values['broken-daemon'] ? ' (its daemon never starts)' : '' } on http://127.0.0.1:${ port }. Start the app on it:

  CLOWDY_UPDATE_FEED=http://127.0.0.1:${ port } CLOWDY_UPDATE_PUBLIC_KEY="$(cat '${ publicPath }')" '${ launcher }' dev
`);
