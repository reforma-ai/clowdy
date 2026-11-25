import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withAppServer } from '../src/providers/appserver';

import type { ProbeContext } from '../src/providers/types';

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clowdy-appserver-'));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

function context(program: string): ProbeContext {
    return {
        program,
        env: { PATH: process.env.PATH ?? '' },
        cwd: root,
        fetch: (async () => new Response('{}')) as unknown as typeof fetch,
        now: () => 1_000,
        platform: 'linux',
        home: join(root, 'home'),
    };
}

describe('a program that ends before the app-server answers', () => {
    test('says why it went: the end of what it wrote to stderr is read after it exits, however much it wrote', async () => {
        const path = join(root, 'app-server-dying');

        writeFileSync(
            path,
            `#!${process.execPath}
process.stdin.once('data', () => {
    console.error('x'.repeat(60_000));
    console.error('why it went');
    process.exit(2);
});
`
        );
        chmodSync(path, 0o755);

        await expect(withAppServer(context(path), rpc => rpc.call('initialize'), 20_000)).rejects.toThrow(
            /ended before it answered \(it wrote: .*why it went\)/s
        );
    });
});
