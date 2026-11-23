import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { isMinimalPath, mergePaths, parseLoginShellPath, resolveLoginShellPath } from './loginShell';

describe('parseLoginShellPath', () => {
    test('reads the PATH between the markers', () => {
        expect(parseLoginShellPath('__CLOWDY_PATH__/usr/bin:/opt/bin__CLOWDY_PATH__')).toBe('/usr/bin:/opt/bin');
    });

    test('ignores what the shell startup files print around it', () => {
        expect(
            parseLoginShellPath('Welcome back!\n[oh-my-zsh] updating...\n__CLOWDY_PATH__/a:/b__CLOWDY_PATH__\nbye\n')
        ).toBe('/a:/b');
    });

    test.each([
        ['no output', ''],
        ['no markers', '/usr/bin:/bin'],
        ['one marker', '__CLOWDY_PATH__/usr/bin'],
        ['an empty PATH', '__CLOWDY_PATH____CLOWDY_PATH__'],
        ['a PATH spread over lines', '__CLOWDY_PATH__/a\n/b__CLOWDY_PATH__'],
    ])('finds nothing in %s', (_name, output) => {
        expect(parseLoginShellPath(output)).toBeUndefined();
    });
});

// The separator defaults to this machine's; the macOS PATHs here name theirs.
describe('isMinimalPath', () => {
    test('recognizes the PATH an app started from Finder gets', () => {
        expect(isMinimalPath('/usr/bin:/bin:/usr/sbin:/sbin', ':')).toBe(true);
        expect(isMinimalPath('/usr/bin:/bin', ':')).toBe(true);
        expect(isMinimalPath(undefined)).toBe(true);
    });

    test('a PATH with any other folder is a real one', () => {
        expect(isMinimalPath('/usr/bin:/bin:/opt/homebrew/bin', ':')).toBe(false);
        expect(isMinimalPath('/usr/local/bin:/usr/bin', ':')).toBe(false);
    });

    test('takes the separator as a parameter', () => {
        expect(isMinimalPath('/usr/bin;/bin', ';')).toBe(true);
    });
});

describe('mergePaths', () => {
    test("puts the login shell first and keeps the app's own folders after it, once each", () => {
        expect(mergePaths('/opt/homebrew/bin:/usr/bin:/bin', '/usr/bin:/bin:/sbin', ':')).toBe(
            '/opt/homebrew/bin:/usr/bin:/bin:/sbin'
        );
    });

    test('works without a current PATH', () => {
        expect(mergePaths('/a:/b', undefined, ':')).toBe('/a:/b');
    });
});

describe.skipIf(process.platform === 'win32')('resolveLoginShellPath', () => {
    let folder: string;

    /** A stand-in for the user's shell: it gets `-ilc <script>` like the real one and runs `body`. */
    async function fakeShell(name: string, body: string): Promise<string> {
        const file = path.join(folder, name);

        await writeFile(file, `#!/bin/sh\n${body}\n`);
        await chmod(file, 0o755);

        return file;
    }

    beforeAll(async () => {
        folder = await mkdtemp(path.join(tmpdir(), 'clowdy-shell-'));
    });

    afterAll(() => rm(folder, { recursive: true, force: true }));

    test('runs the shell as an interactive login shell and returns the PATH it prints', async () => {
        // Prints a banner as a noisy rc file would, then evaluates the command like `sh -c`.
        const shell = await fakeShell(
            'noisy',
            'echo "banner" >&2; echo "motd"; [ "$1" = "-ilc" ] || exit 3; eval "$2"'
        );
        const env = { PATH: '/from/login:/usr/bin' };

        expect(await resolveLoginShellPath(shell, env)).toBe('/from/login:/usr/bin');
    });

    test('gives up on a shell that prints no PATH', async () => {
        const shell = await fakeShell('silent', 'exit 0');

        expect(await resolveLoginShellPath(shell, {})).toBeUndefined();
    });

    test('gives up on a missing shell', async () => {
        expect(await resolveLoginShellPath(path.join(folder, 'missing'), {})).toBeUndefined();
    });

    test('gives up on a shell that hangs, after the timeout', async () => {
        const shell = await fakeShell('hanging', 'exec sleep 30');
        const started = Date.now();

        expect(await resolveLoginShellPath(shell, {}, 200)).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(5000);
    });
});
