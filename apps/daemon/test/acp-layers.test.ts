import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KNOWN_AGENTS } from '../src/engine/acp/catalog';
import { Discovery } from '../src/engine/acp/discovery';
import { AgentRegistry } from '../src/engine/acp/registry';
import { collect, rig, textOf, types } from './acp-helpers';

import type { Rig } from './acp-helpers';

let root: string;
let bin: string;
let current: Rig | undefined;

/** An executable that prints a version when run, so discovery finds the agent installed. */
function program(name: string): string {
    const path = join(bin, name);

    writeFileSync(path, '#!/bin/sh\necho "1.0.0"\n');
    chmodSync(path, 0o755);

    return path;
}

const registry = () => new AgentRegistry({
    discovery: new Discovery({ env: { PATH: bin }, home: join(root, 'home'), loginPath: async () => undefined, installDirs: [] }),
    runtime: async () => process.execPath,
});

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clowdy-layers-'));
    bin = join(root, 'bin');
    mkdirSync(bin);
    mkdirSync(join(root, 'home'));
});

afterEach(() => {
    current?.stop();
    current = undefined;
    rmSync(root, { recursive: true, force: true });
});

describe('the protocol of an agent', () => {
    test('a built-in agent resolves with the protocol its catalog entry names, and v1 when it names none', async () => {
        const reg = registry();
        const [spec] = KNOWN_AGENTS;
        const named = spec.protocol;

        program(spec.programs[0]);

        const protocolOf = async () => {
            const resolved = await reg.resolve(spec.id);

            return resolved.ok && resolved.agent.protocol;
        };

        try {
            delete spec.protocol;
            expect(await protocolOf()).toBe('v1');

            spec.protocol = 'v2';
            expect(await protocolOf()).toBe('v2');
        }
        finally {
            if (named) {
                spec.protocol = named;
            }
            else {
                delete spec.protocol;
            }
        }
    });

    test('a custom agent speaks v1', async () => {
        const reg = registry();

        reg.add({ id: 'mine', name: 'Mine', command: program('mine'), args: [], env: {} });

        const resolved = await reg.resolve('mine');

        expect(resolved.ok && resolved.agent.protocol).toBe('v1');
    });

    test('an agent set to v2 is spoken to in v1 while the engine has no v2 layer', async () => {
        const { registry: agents, start } = current = rig();
        const resolve = agents.resolve.bind(agents);

        agents.resolve = async (id) => {
            const found = await resolve(id);

            return found.ok ? { ok: true, agent: { ...found.agent, protocol: 'v2' } } : found;
        };

        const { session } = start('say hello world');
        const events = await collect(session);

        await session.close();

        expect(types(events)).toEqual(['process', 'session', 'text', 'text', 'text', 'done']);
        expect(textOf(events)).toBe('hello world');
    });
});
