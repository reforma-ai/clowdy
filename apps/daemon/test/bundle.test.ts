import { PROTOCOL_VERSION, ROUTES, type DaemonInfo, type Health } from '@clowdy/protocol';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { bundleDaemon } from '../scripts/bundle';
import { cleanTempDirs, tempDir } from './helpers';

const SYSTEM_SKILLS = resolve(import.meta.dir, '../../../packages/system-skills');

let out: string;

beforeAll(async () => {
    out = tempDir('clowdy-bundle');
    await bundleDaemon(out, '412');
});

afterAll(cleanTempDirs);

async function until<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        const value = read();

        if (value !== undefined) return value;

        if (Date.now() > deadline) throw new Error('Timed out');

        await Bun.sleep(50);
    }
}

test('a bundled daemon runs on its own and reports the bundle version', async () => {
    const root = tempDir();
    const dataDir = join(root, 'data');
    const daemon = Bun.spawn([process.execPath, join(out, 'main.js')], {
        cwd: root,
        env: {
            PATH: process.env.PATH,
            HOME: root,
            CLOWDY_DATA_DIR: dataDir,
            CLOWDY_PROJECTS_DIR: join(root, 'projects'),
            CLOWDY_PERSONAL_DIR: join(root, 'personal'),
            CLOWDY_USER_SKILLS_DIRS: join(root, 'skills'),
            CLOWDY_SYSTEM_SKILLS_DIR: SYSTEM_SKILLS,
            CLOWDY_ENGINE: 'fake',
        },
        stdout: 'ignore',
        // A daemon that cannot start says why here.
        stderr: 'inherit',
    });

    try {
        const info = await until(() => existsSync(join(dataDir, 'daemon.json')) ? JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8')) as DaemonInfo : undefined);
        const health = await (await fetch(`http://127.0.0.1:${ info.port }${ ROUTES.health }`)).json() as Health;

        expect(health).toMatchObject({ ok: true, protocol: PROTOCOL_VERSION, version: '412', pid: daemon.pid });

        await fetch(`http://127.0.0.1:${ info.port }${ ROUTES.shutdown }`, { method: 'POST', headers: { authorization: `Bearer ${ info.token }` } });
        expect(await daemon.exited).toBe(0);
    }
    finally {
        daemon.kill();
    }
});

test('the MCP server an agent starts sits beside main.js and runs on its own', async () => {
    const bridge = Bun.spawn([process.execPath, join(out, 'mcp-stdio.js')], {
        env: { PATH: process.env.PATH, CLOWDY_BRIDGE_URL: 'http://127.0.0.1:1', CLOWDY_BRIDGE_TOKEN: 'token' },
        stdin: 'pipe',
        stdout: 'pipe',
    });

    bridge.stdin.write(`${ JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) }\n`);
    await bridge.stdin.end();

    const [reply] = (await new Response(bridge.stdout).text()).trim().split('\n').map(line => JSON.parse(line) as { id: number; result: { serverInfo: { name: string } } });

    expect(reply).toMatchObject({ id: 1, result: { serverInfo: { name: 'clowdy' } } });
});
