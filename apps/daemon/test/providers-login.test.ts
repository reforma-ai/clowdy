import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseSignInOutput } from '../src/providers/login';
import { ProvidersService } from '../src/providers/service';
import { testSpec } from './helpers';

import type { AgentInfo } from '@clowdy/protocol';
import type { AgentRegistry } from '../src/engine/acp/registry';
import type { Provider } from '../src/providers/types';

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clowdy-login-'));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

function program(name: string, body: string): string {
    const path = join(root, name);

    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);

    return path;
}

const info = (): AgentInfo => ({
    id: 'claude',
    name: 'Claude Code',
    custom: false,
    enabled: true,
    status: 'ready',
    launch: 'claude',
});

/** A service whose agent `claude` is the script `body`, with a reader that says "signed in" once the marker file exists. */
function rig(body: string, options: { loginTimeoutMs?: number; announce?: () => void } = {}) {
    const marker = join(root, 'signed-in');
    const announced: number[] = [];
    const registry = {
        probeTarget: async () => ({
            program: program('claude', body.replaceAll('$MARKER', marker)),
            env: { PATH: process.env.PATH ?? '' },
        }),
        list: async () => [info()],
        nameOf: () => 'Claude Code',
    } as unknown as AgentRegistry;
    const provider: Provider = {
        ...testSpec('claude'),
        login: { args: ['auth', 'login'] },
        read: async () => ({
            signIn: { status: (await Bun.file(marker).exists()) ? 'signed-in' : 'signed-out' },
            usage: { state: 'unavailable', windows: [] },
        }),
    };
    const service = new ProvidersService({
        registry,
        providers: [provider],
        announce: () => void announced.push(1),
        cwd: root,
        ...options,
    });
    const session = () => service.decorate([info()])[0]!.signInSession;
    const until = async (check: () => boolean) => {
        for (let i = 0; i < 200 && !check(); i++) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    };

    return { service, session, until, announced };
}

describe('parseSignInOutput', () => {
    test('finds the link and the code, whatever the program printed around them', () => {
        expect(
            parseSignInOutput(
                'Opening browser to sign in…\nIf it did not open, visit:\n  https://claude.ai/oauth/authorize?code=true&client_id=abc.\n'
            )
        ).toEqual({ url: 'https://claude.ai/oauth/authorize?code=true&client_id=abc' });
        expect(
            parseSignInOutput(
                'Navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?x=1\n\nEnter this one-time code: ABCD-1234\n'
            )
        ).toEqual({ url: 'https://auth.openai.com/oauth/authorize?x=1', code: 'ABCD-1234' });
        expect(
            parseSignInOutput(
                '\u001B]8;;https://cursor.com/loginDeepControl?x=1\u001B\\open this\u001B]8;;\u001B\\ and https://cursor.com/docs'
            )
        ).toEqual({ url: 'https://cursor.com/loginDeepControl?x=1' });
        expect(parseSignInOutput('error: access_denied')).toEqual({ denied: true });
        expect(parseSignInOutput('nothing to see')).toEqual({});
    });

    test("takes the page, not the program's own listener, and no code from inside a link", () => {
        const output =
            'Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?client_id=app_X&state=AB12-CD34\n';

        expect(parseSignInOutput(output)).toEqual({
            url: 'https://auth.openai.com/oauth/authorize?client_id=app_X&state=AB12-CD34',
        });
        expect(parseSignInOutput('Starting local login server on http://127.0.0.1:1455.\n')).toEqual({});
        expect(parseSignInOutput(`${output}Enter this one-time code: WXYZ-5678`)).toMatchObject({ code: 'WXYZ-5678' });
    });
});

describe('signing in', () => {
    test('runs the login program, passes on its link and code, and reads the account when it ends well', async () => {
        const { service, session, until, announced } = rig(
            'echo "Visit https://claude.ai/login?x=1 and enter ABCD-1234"; sleep 0.3; touch "$MARKER"; exit 0'
        );

        service.decorate([info()]);
        service.signIn('claude');

        expect(session()).toMatchObject({ step: 'starting' });

        await until(() => session()?.url !== undefined);

        expect(session()).toMatchObject({ step: 'waiting', url: 'https://claude.ai/login?x=1', code: 'ABCD-1234' });

        await until(() => session()?.step === 'done');
        await until(() => service.decorate([info()])[0]!.signIn?.status === 'signed-in');

        expect(session()?.step).toBe('done');
        expect(service.decorate([info()])[0]!.signIn?.status).toBe('signed-in');
        expect(announced.length).toBeGreaterThan(2);
    });

    test('reports why a login failed, and can be started again', async () => {
        const { service, session, until } = rig('echo "Login failed: the code expired" >&2; exit 1');

        service.signIn('claude');
        await until(() => session()?.step === 'failed');

        expect(session()).toMatchObject({ step: 'failed', message: 'Login failed: the code expired' });

        service.signIn('claude');

        expect(session()?.step).toBe('starting');
        await until(() => session()?.step === 'failed');
    });

    test('refuses a second sign-in while one runs, and cancel ends the program', async () => {
        const { service, session, until } = rig('echo started; sleep 30');

        service.signIn('claude');
        await until(() => session()?.step === 'waiting');

        expect(() => service.signIn('claude')).toThrow('already running');

        service.cancelSignIn('claude');
        await until(() => session()?.step === 'cancelled');

        expect(session()).toMatchObject({ step: 'cancelled', message: 'Sign-in cancelled' });
    });

    test('stops a login that takes too long, and one that the page refused', async () => {
        const slow = rig('sleep 30', { loginTimeoutMs: 200 });

        slow.service.signIn('claude');
        await slow.until(() => slow.session()?.step === 'failed');

        expect(slow.session()).toMatchObject({ step: 'failed', message: 'The sign-in took too long' });

        const denied = rig('echo "error: access_denied"; sleep 30');

        denied.service.signIn('claude');
        await denied.until(() => denied.session()?.step === 'failed');

        expect(denied.session()).toMatchObject({ step: 'failed', message: 'The sign-in was refused' });
    });

    test('is not a sign-in when the program was stopped by the deadline and then left with exit code 0', async () => {
        // A program that catches the stop and says it ended well.
        const { service, session, until } = rig(
            `exec '${process.execPath}' -e "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"`,
            { loginTimeoutMs: 400 }
        );

        service.signIn('claude');
        await until(() => session()?.step === 'failed' || session()?.step === 'done');

        expect(session()).toMatchObject({ step: 'failed', message: 'The sign-in took too long' });
    });

    test('goes on when announcing to the clients fails, from the output of the program and from its end', async () => {
        const logged = spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            const { service, session, until } = rig(
                'echo "Visit https://claude.ai/login?x=1"; sleep 0.2; touch "$MARKER"; exit 0',
                {
                    announce: () => {
                        throw new Error('the database is closed');
                    },
                }
            );

            service.signIn('claude');
            await until(() => session()?.step === 'done');
            await until(() => service.decorate([info()])[0]!.signIn?.status === 'signed-in');

            expect(session()).toMatchObject({ step: 'done', url: 'https://claude.ai/login?x=1' });
            expect(service.decorate([info()])[0]!.signIn?.status).toBe('signed-in');
        } finally {
            logged.mockRestore();
        }
    });

    test('says so when the agent has no login to run or is not installed', async () => {
        const { service, session, until } = rig('exit 0');

        expect(() => service.signIn('other')).toThrow('cannot sign in');

        const missing = new ProvidersService({
            registry: {
                probeTarget: async () => undefined,
                list: async () => [info()],
                nameOf: () => 'Claude Code',
            } as unknown as AgentRegistry,
            providers: [
                {
                    ...testSpec('claude'),
                    login: { args: ['login'] },
                    read: async () => ({ signIn: { status: 'unknown' }, usage: { state: 'unavailable', windows: [] } }),
                },
            ],
            announce: () => undefined,
        });

        missing.signIn('claude');
        await until(() => missing.decorate([info()])[0]!.signInSession?.step === 'failed');

        expect(missing.decorate([info()])[0]!.signInSession).toMatchObject({
            step: 'failed',
            message: expect.stringContaining('not installed'),
        });
        expect(session()).toBeUndefined();
    });
});
