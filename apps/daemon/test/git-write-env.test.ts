import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { namesSigningKey, remoteHost, WriteEnvironment } from '../src/git/writeEnv';
import { cleanTempDirs, git, makeRepo, tempDir } from './helpers';

afterAll(cleanTempDirs);

const posix = process.platform !== 'win32';
/** The stand-in `ssh` and shell are POSIX shell scripts: on Windows these cases are skipped, not run against another program. */
const withStandIns = posix ? describe : describe.skip;

describe('remoteHost', () => {
    test('reads the host of every form of address and nothing else of it', () => {
        expect(remoteHost('git@github.com:acme/app.git')).toBe('github.com');
        expect(remoteHost('github.com:acme/app')).toBe('github.com');
        expect(remoteHost('ssh://git@Git.Example.com:2222/acme/app.git')).toBe('git.example.com');
        expect(remoteHost('git://github.com/acme/app.git')).toBe('github.com');
        expect(remoteHost('https://user:s3cret@github.com/acme/app.git')).toBe('github.com');
        expect(remoteHost('https://ghe.example.com:8443/acme/app')).toBe('ghe.example.com');
        expect(remoteHost('git@work-alias:team/app.git')).toBe('work-alias');
        expect(remoteHost('git@work-alias:app.git')).toBe('work-alias');
    });

    test('says nothing of a path on the disk, a drive letter or a name that could be an option', () => {
        for (const address of ['', '/srv/git/app.git', '../app', 'app', 'C:\\work\\app', 'C:/work/app', 'file:///srv/git/app.git', 'https://-oProxyCommand=x/acme/app', '-oProxyCommand=x:acme/app']) {
            expect(remoteHost(address)).toBeUndefined();
        }
    });
});

describe('namesSigningKey', () => {
    test('knows the lines git and ssh-keygen print when a signature cannot be made', () => {
        for (const line of [
            'error: No private key found for public key "/Users/me/Library/Containers/x/PublicKeys/abc.pub"?',
            'Signing failed: agent refused operation',
            'communication with agent failed',
            'Couldn\'t get agent socket?',
            'error: Load key "/x": invalid format',
        ]) {
            expect(namesSigningKey(line)).toBe(true);
        }
    });

    test('leaves the failures that have nothing to do with the key alone', () => {
        for (const line of ['fatal: unable to auto-detect email address', 'lint failed: 2 problems', 'nothing to commit, working tree clean']) {
            expect(namesSigningKey(line)).toBe(false);
        }
    });
});

/** An executable file with the lines as its script. */
function script(dir: string, name: string, ...lines: string[]): string {
    const path = join(dir, name);

    writeFileSync(path, ['#!/bin/sh', 'PATH=/usr/bin:/bin', ...lines].join('\n'));
    chmodSync(path, 0o755);

    return path;
}

/** The lines a stand-in has written to its log, one for each call. */
const calls = (log: string): string[] => {
    try {
        return readFileSync(log, 'utf8').split('\n').filter(line => line !== '');
    }
    catch {
        return [];
    }
};

/** What the stand-ins are given: an `ssh` that says `ssh` and a shell that says `shell` (nothing when the answer is none), and the logs of their calls. */
function standIns({ ssh, shell }: { ssh?: string; shell?: string }) {
    const dir = tempDir('write-env');
    const sshLog = join(dir, 'ssh.log');
    const shellLog = join(dir, 'shell.log');

    mkdirSync(join(dir, 'bin'));
    script(join(dir, 'bin'), 'ssh', `echo "$@" >> '${ sshLog }'`, 'echo "Pseudo-terminal will not be allocated" >&2', 'echo "host x"', ...(ssh === undefined ? [] : [`echo "identityagent ${ ssh }"`]), 'echo "user git"');
    const shellProgram = script(dir, 'shell', `echo "$@" >> '${ shellLog }'`, 'echo "Last login: Mon"', `printf '__CLOWDY_SOCK__%s__CLOWDY_SOCK__' '${ shell ?? '' }'`, 'echo "motd"');

    return { dir, sshLog, shellLog, shellProgram, bin: join(dir, 'bin') };
}

/** A repository whose `origin` is an address nothing ever contacts; one for each address, since making one takes a while. */
const withOrigin = new Map<string, string>();

function repositoryWithOrigin(address = 'git@github.com:acme/app.git'): string {
    let path = withOrigin.get(address);

    if (!path) {
        path = makeRepo(tempDir('write-env'));
        git(path, 'remote', 'add', 'origin', address);
        withOrigin.set(address, path);
    }

    return path;
}

const LAUNCHD = '/var/run/com.apple.launchd.abc/Listeners';

withStandIns('WriteEnvironment', () => {
    const environment = (extra: Record<string, string | undefined>, options: ConstructorParameters<typeof WriteEnvironment>[0] = {}) => new WriteEnvironment({
        env: () => ({ HOME: '/home/test', SSH_AUTH_SOCK: LAUNCHD, ...extra }),
        ...options,
    });

    test('takes the socket from ssh -G for the host of origin, and puts it in place of the inherited one', async () => {
        const stand = standIns({ ssh: '/tmp/clowdy-test/secretive.sock', shell: '/tmp/clowdy-test/shell.sock' });
        const env = await environment({ PATH: stand.bin, SHELL: stand.shellProgram }).of(repositoryWithOrigin());

        expect(env.SSH_AUTH_SOCK).toBe('/tmp/clowdy-test/secretive.sock');
        // The host is asked for after `--`, so a host that looks like an option is never one.
        expect(calls(stand.sshLog)).toEqual(['-G -- github.com']);
        // The login shell was not needed.
        expect(calls(stand.shellLog)).toEqual([]);
    });

    test('is the daemon\'s environment with no prompt for a password, git in English and none of the daemon\'s own secrets', async () => {
        const stand = standIns({ ssh: '/tmp/clowdy-test/secretive.sock' });
        const env = await environment({ PATH: stand.bin, SHELL: stand.shellProgram, LANG: 'de_DE.UTF-8', CLOWDY_TOKEN: 'secret', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1' }).of(repositoryWithOrigin());

        expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', LANGUAGE: 'C', HOME: '/home/test', LANG: 'de_DE.UTF-8', PATH: stand.bin });
        expect(Object.keys(env).filter(name => /CLOWDY|NODE_OPTIONS|ELECTRON/.test(name))).toEqual([]);
    });

    test('never changes the environment of the daemon itself', async () => {
        const before = process.env.SSH_AUTH_SOCK;
        const stand = standIns({ ssh: '/tmp/clowdy-test/secretive.sock' });

        await environment({ PATH: stand.bin }).of(repositoryWithOrigin());

        expect(process.env.SSH_AUTH_SOCK).toBe(before);
    });

    test('takes it from the login shell when ssh names none, a variable, or a path that is not absolute', async () => {
        for (const named of [undefined, 'none', 'SSH_AUTH_SOCK', 'relative/agent.sock']) {
            const stand = standIns({ ssh: named, shell: '/tmp/clowdy-test/shell.sock' });
            const env = await environment({ PATH: stand.bin, SHELL: stand.shellProgram }).of(repositoryWithOrigin());

            expect(env.SSH_AUTH_SOCK).toBe('/tmp/clowdy-test/shell.sock');
            // Run as the `PATH` is taken: an interactive login shell, whose startup noise is ignored.
            expect(calls(stand.shellLog)).toHaveLength(1);
            expect(calls(stand.shellLog)[0]).toStartWith('-ilc printf');
        }
    });

    test('reads a socket whose folder has a space in it, and expands ~ with the home it is given', async () => {
        const spaced = standIns({ ssh: '/tmp/clowdy test/Group Containers/agent.sock' });
        const home = standIns({ ssh: '~/Library/agent.sock' });

        expect((await environment({ PATH: spaced.bin }).of(repositoryWithOrigin())).SSH_AUTH_SOCK).toBe('/tmp/clowdy test/Group Containers/agent.sock');
        expect((await environment({ PATH: home.bin }, { home: '/home/test' }).of(repositoryWithOrigin())).SSH_AUTH_SOCK).toBe('/home/test/Library/agent.sock');
    });

    test('goes to the login shell for a place with no origin, and leaves the inherited socket when nothing is found', async () => {
        const none = standIns({ ssh: '/tmp/clowdy-test/secretive.sock' });
        const noOrigin = makeRepo(tempDir('write-env'));

        expect((await environment({ PATH: none.bin, SHELL: none.shellProgram }).of(noOrigin)).SSH_AUTH_SOCK).toBe(LAUNCHD);
        // Nothing asked ssh: there was no host to ask it about.
        expect(calls(none.sshLog)).toEqual([]);
        expect(calls(none.shellLog)).toHaveLength(1);

        const nothing = standIns({});

        expect((await environment({ PATH: nothing.bin, SHELL: nothing.shellProgram }).of(repositoryWithOrigin())).SSH_AUTH_SOCK).toBe(LAUNCHD);
    });

    test('leaves the inherited socket when there is no ssh on the PATH and the shell does not answer in time', async () => {
        const stand = standIns({ shell: '/tmp/clowdy-test/shell.sock' });
        const slow = script(stand.dir, 'slow-shell', 'sleep 5');
        const env = await environment({ PATH: join(stand.dir, 'nothing'), SHELL: slow }, { shellTimeoutMs: 200 }).of(repositoryWithOrigin());

        expect(env.SSH_AUTH_SOCK).toBe(LAUNCHD);
        expect(calls(stand.sshLog)).toEqual([]);
    });

    test('finds the socket once for a host, and again after a failure that names the signing key', async () => {
        const stand = standIns({ ssh: '/tmp/clowdy-test/secretive.sock' });
        const write = environment({ PATH: stand.bin });
        const place = repositoryWithOrigin();

        await write.of(place);
        await write.of(place);
        expect(calls(stand.sshLog)).toHaveLength(1);

        write.forgetAgent();
        await write.of(place);
        expect(calls(stand.sshLog)).toHaveLength(2);

        // Another host is another question: a host ssh is configured for by name may have its own agent.
        await write.of(repositoryWithOrigin('git@work-alias:team/app.git'));
        expect(calls(stand.sshLog)).toEqual(['-G -- github.com', '-G -- github.com', '-G -- work-alias']);
    });

    test('is the daemon\'s environment on Windows, whose OpenSSH keeps its agent on a pipe git finds itself', async () => {
        const stand = standIns({ ssh: '/tmp/clowdy-test/secretive.sock' });
        const env = await environment({ PATH: stand.bin }, { platform: 'win32' }).of(repositoryWithOrigin());

        expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', SSH_AUTH_SOCK: LAUNCHD });
        expect(calls(stand.sshLog)).toEqual([]);
    });
});
