import { daemonDataDir, PROTOCOL_HEADER, PROTOCOL_VERSION, ROUTES, type DaemonInfo } from '@clowdy/protocol';
/**
 * `bun run stop`: asks the running daemon of this data dir to shut down (graceful: engines are aborted, runs that
 * were live are marked interrupted at the next start). `CLOWDY_PROFILE=dev bun run stop` stops the dev app's daemon.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { infoPath } from './instance';

const STOP_TIMEOUT_MS = 10_000;
const dataDir = daemonDataDir({ platform: process.platform, home: homedir(), env: process.env });
const file = infoPath(dataDir);

if (!existsSync(file)) {
    console.log(`No daemon is running for ${ dataDir }.`);
    process.exit(0);
}

const info = JSON.parse(readFileSync(file, 'utf8')) as DaemonInfo;
const base = `http://127.0.0.1:${ info.port }`;
const response = await fetch(`${ base }${ ROUTES.shutdown }`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ info.token }`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
}).catch(() => undefined);

if (!response) {
    console.log(`The daemon (pid ${ info.pid }) did not answer; its daemon.json is stale and the next start replaces it.`);
    process.exit(0);
}

const deadline = Date.now() + STOP_TIMEOUT_MS;

while (existsSync(file) && Date.now() < deadline) await Bun.sleep(100);

if (existsSync(file)) {
    console.error(`The daemon (pid ${ info.pid }) did not stop within ${ STOP_TIMEOUT_MS / 1000 } s.`);
    process.exit(1);
}

console.log(`Stopped the daemon (pid ${ info.pid }).`);
