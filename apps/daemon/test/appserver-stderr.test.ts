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
    test('says why it went: the last of what it wrote to stderr is read after it exits', async () => {
        const path = join(root, 'app-server-dying');

        // The program leaves at once, as soon as it is asked. A process it started in a group of its own (it survives the program's group being killed)
        // holds stderr open and writes the last words a moment later: the pipe closes after the exit.
        writeFileSync(
            path,
            `#!${process.execPath}
process.stdin.once('data', () => {
    require('node:child_process')
        .spawn(process.execPath, ['-e', "setTimeout(() => console.error('why it went'), 300)"], {
            detached: true,
            stdio: ['ignore', 'ignore', 'inherit'],
        })
        .unref();
    process.exit(2);
});
`
        );
        chmodSync(path, 0o755);

        await expect(withAppServer(context(path), rpc => rpc.call('initialize'), 20_000)).rejects.toThrow(
            'ended before it answered (it wrote: why it went)'
        );
    });
});
