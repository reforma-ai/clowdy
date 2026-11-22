import { describe, expect, spyOn, test } from 'bun:test';

import { ProvidersService } from '../src/providers/service';
import { testSpec } from './helpers';

import type { AgentInfo } from '@clowdy/protocol';
import type { AgentRegistry } from '../src/engine/acp/registry';
import type { Provider, ProviderRead } from '../src/providers/types';

const info = (id: string, status: AgentInfo['status'] = 'ready'): AgentInfo => ({ id, name: id, custom: false, enabled: status !== 'disabled', status, launch: id });

/** A registry that knows `ready` agents and hands out a program for them. */
function registry(ready: string[]): AgentRegistry {
    return {
        probeTarget: async (id: string) => ready.includes(id) ? { program: `/bin/${ id }`, env: { PATH: '/bin' } } : undefined,
        list: async () => ready.map(id => info(id)),
    } as unknown as AgentRegistry;
}

const ok = (percent: number, email = 'ada@example.com'): ProviderRead => ({
    signIn: { status: 'signed-in', account: { email, method: 'subscription' } },
    usage: { state: 'ok', windows: [{ id: 'session', label: 'Session', usedPercent: percent }], fetchedAt: 1 },
});

/** A provider whose reads come from a script, one per call, and a clock the test moves. */
function rig(reads: ProviderRead[], { login = true }: { login?: boolean } = {}) {
    let time = 1_000_000;
    let calls = 0;
    const announced: number[] = [];
    const provider: Provider = {
        ...testSpec('claude'),
        ...(login && { login: { args: ['auth', 'login'] } }),
        read: async () => reads[Math.min(calls++, reads.length - 1)]!,
    };
    const service = new ProvidersService({ registry: registry(['claude']), providers: [provider], announce: () => void announced.push(time), now: () => time, freshMs: 60_000, cwd: '/tmp' });

    return { service, announced, calls: () => calls, advance: (ms: number) => void (time += ms) };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('ProvidersService', () => {
    test('keeps the permission presets the registry listed, for an agent with an account and for one with none to read', async () => {
        const { service } = rig([ok(8)]);
        const permissions = { presets: [{ id: 'ask' as const, name: 'Ask for approval', description: 'x' }], default: 'ask' as const };
        const plain = { ...testSpec('plain') };

        expect(service.decorate([{ ...info('claude'), permissions }])[0]?.permissions).toEqual(permissions);
        expect(new ProvidersService({ registry: registry(['plain']), providers: [plain], announce: () => undefined, cwd: '/tmp' }).decorate([{ ...info('plain'), permissions }])[0]?.permissions).toEqual(permissions);
    });

    test('reuses a read as long as its provider says, not as long as the default', async () => {
        let time = 1_000_000;
        let calls = 0;
        const provider: Provider = { ...testSpec('claude'), freshMs: 300_000, read: async () => {
            calls++; return ok(8);
        } };
        const service = new ProvidersService({ registry: registry(['claude']), providers: [provider], announce: () => undefined, now: () => time, freshMs: 60_000, cwd: '/tmp' });

        service.decorate([info('claude')]);
        await settle();
        time += 200_000;
        service.decorate([info('claude')]);
        await settle();

        expect(calls).toBe(1);

        time += 150_000;
        service.decorate([info('claude')]);
        await settle();

        expect(calls).toBe(2);
    });

    test('leaves an agent whose provider is only a spec as the registry found it, and reads nothing for it', async () => {
        let probed = 0;
        const plain = { ...registry(['plain']), probeTarget: async () => void probed++, nameOf: () => 'Plain' } as unknown as AgentRegistry;
        const service = new ProvidersService({ registry: plain, providers: [testSpec('plain')], announce: () => undefined, cwd: '/tmp' });

        expect(service.decorate([info('plain')])).toEqual([info('plain')]);
        expect(() => service.signIn('plain')).toThrow('cannot sign in');

        service.refresh();
        await settle();

        expect(probed).toBe(0);
    });

    test('answers at once without the account, reads it in the background, and announces what it found', async () => {
        const { service, announced, calls } = rig([ok(8)]);
        const first = service.decorate([info('claude')]);

        expect(first[0]).toMatchObject({ id: 'claude', canSignIn: true });
        expect(first[0]!.signIn).toBeUndefined();

        await settle();

        expect(calls()).toBe(1);
        expect(announced).toHaveLength(1);
        expect(service.decorate([info('claude')])[0]).toMatchObject({
            signIn: { status: 'signed-in', account: { email: 'ada@example.com' }, checkedAt: 1_000_000 },
            usage: { state: 'ok', windows: [{ id: 'session', usedPercent: 8 }] },
        });
    });

    test('reuses a read while it is fresh, reads again when it is old, and announces only a change', async () => {
        const { service, announced, calls, advance } = rig([ok(8), ok(8), ok(9)]);

        service.decorate([info('claude')]);
        await settle();
        advance(30_000);
        service.decorate([info('claude')]);
        await settle();

        expect(calls()).toBe(1);

        advance(40_000);
        service.decorate([info('claude')]);
        await settle();

        // The second read found the same numbers: nothing to tell.
        expect(calls()).toBe(2);
        expect(announced).toHaveLength(1);

        advance(61_000);
        service.decorate([info('claude')]);
        await settle();

        expect(calls()).toBe(3);
        expect(announced).toHaveLength(2);
    });

    test('does not read an agent that is not ready or has no reader, and offers no sign-in for a reader without a login', async () => {
        const { service, calls } = rig([ok(1)]);

        expect(service.decorate([info('claude', 'missing'), info('claude', 'disabled'), info('other')]).map(agent => agent.signIn)).toEqual([undefined, undefined, undefined]);
        await settle();

        expect(calls()).toBe(0);
        expect(rig([ok(1)], { login: false }).service.decorate([info('claude')])[0]!.canSignIn).toBe(false);
    });

    test('keeps the last good usage with an error note when a read fails, and tries again after a pause that grows', async () => {
        const failed: ProviderRead = { signIn: { status: 'signed-in', account: { email: 'ada@example.com' } }, usage: { state: 'error', windows: [], detail: 'offline' } };
        const { service, calls, advance } = rig([ok(8), failed, failed, ok(10)]);

        service.decorate([info('claude')]);
        await settle();
        advance(61_000);
        service.decorate([info('claude')]);
        await settle();

        expect(service.decorate([info('claude')])[0]!.usage).toEqual({ state: 'error', detail: 'offline', windows: [{ id: 'session', label: 'Session', usedPercent: 8 }], fetchedAt: 1 });
        expect(calls()).toBe(2);

        // A failure waits 30 s before the next try, and a second one 60 s.
        advance(20_000);
        service.decorate([info('claude')]);
        await settle();

        expect(calls()).toBe(2);

        advance(11_000);
        service.decorate([info('claude')]);
        await settle();
        advance(40_000);
        service.decorate([info('claude')]);
        await settle();

        expect(calls()).toBe(3);

        advance(30_000);
        service.decorate([info('claude')]);
        await settle();

        expect(calls()).toBe(4);
        expect(service.decorate([info('claude')])[0]!.usage).toMatchObject({ state: 'ok', windows: [{ usedPercent: 10 }] });
    });

    test('forget ignores a read that was under way: what it found is neither kept nor announced', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const announced: number[] = [];
        let calls = 0;
        const service = new ProvidersService({
            registry: registry(['claude']),
            providers: [{ ...testSpec('claude'), read: async () => (++calls === 1 ? (await gate, ok(1)) : ok(2)) }],
            announce: () => void announced.push(1),
            cwd: '/tmp',
        });

        service.decorate([info('claude')]);
        await settle();
        service.forget('claude');
        release();
        await settle();

        expect(announced).toHaveLength(0);

        service.decorate([info('claude')]);
        await settle();

        expect(calls).toBe(2);
        expect(service.decorate([info('claude')])[0]!.usage?.windows[0]?.usedPercent).toBe(2);
    });

    test('readNow waits out a read that began before and reads once more, so a sign-in that has just ended is seen', async () => {
        const signedOut: ProviderRead = { signIn: { status: 'signed-out' }, usage: { state: 'unavailable', windows: [] } };
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let calls = 0;
        const service = new ProvidersService({
            registry: registry(['claude']),
            providers: [{ ...testSpec('claude'), read: async () => (++calls === 1 ? (await gate, signedOut) : ok(8)) }],
            announce: () => undefined,
            cwd: '/tmp',
        });

        // This read began while the login was still running: it will report nobody.
        service.decorate([info('claude')]);
        await settle();

        const seen = service.readNow('claude');

        release();
        await seen;

        expect(calls).toBe(2);
        expect(service.decorate([info('claude')])[0]!.signIn?.status).toBe('signed-in');
    });

    test('a failing announce does not lose the read, and a reader that throws is tried again after a pause', async () => {
        const logged = spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            let time = 1_000_000;
            let calls = 0;
            const service = new ProvidersService({
                registry: registry(['claude']),
                providers: [{
                    ...testSpec('claude'),
                    read: async () => {
                        if (++calls === 1) {
                            throw new Error('the reader is broken');
                        }

                        return ok(3);
                    },
                }],
                announce: () => {
                    throw new Error('the database is closed');
                },
                now: () => time,
                cwd: '/tmp',
            });

            service.decorate([info('claude')]);
            await settle();
            service.decorate([info('claude')]);
            await settle();

            // A broken reader is not asked again at once, whoever asks.
            expect(calls).toBe(1);

            time += 31_000;
            service.decorate([info('claude')]);
            await settle();

            expect(calls).toBe(2);
            expect(service.decorate([info('claude')])[0]!.usage?.windows[0]?.usedPercent).toBe(3);
        }
        finally {
            logged.mockRestore();
        }
    });

    test('stop ends the programs of a read under way, and nothing is read or announced after it', async () => {
        let signal: AbortSignal | undefined;
        let calls = 0;
        const announced: number[] = [];
        const service = new ProvidersService({
            registry: registry(['claude']),
            providers: [{
                ...testSpec('claude'),
                read: async (context) => {
                    calls++;
                    signal = context.signal;
                    await new Promise(resolve => context.signal?.addEventListener('abort', resolve));

                    return ok(5);
                },
            }],
            announce: () => void announced.push(1),
            cwd: '/tmp',
        });

        service.decorate([info('claude')]);
        await settle();
        service.stop();
        await settle();
        service.decorate([info('claude')]);
        await settle();

        expect(signal?.aborted).toBe(true);
        expect(calls).toBe(1);
        expect(announced).toHaveLength(0);
    });

    test('refresh reads again at once, and forget drops what was known', async () => {
        const { service, calls } = rig([ok(8), ok(9)]);

        service.decorate([info('claude')]);
        await settle();
        service.refresh();
        await settle();

        expect(calls()).toBe(2);
        expect(service.decorate([info('claude')])[0]!.usage?.windows[0]?.usedPercent).toBe(9);

        service.forget('claude');
        // Forgotten: nothing is known until the next read has run.
        const [again] = service.decorate([info('claude')]);

        expect(again!.signIn).toBeUndefined();
    });
});
