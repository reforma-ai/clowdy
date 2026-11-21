import { describe, expect, test } from 'bun:test';

import { createEngines } from '../src/engine';
import { AcpEngine } from '../src/engine/acp/engine';
import { AgentRegistry } from '../src/engine/acp/registry';
import { FakeEngine } from '../src/engine/fake';
import { quietDiscovery } from './acp-helpers';
import { testConfig } from './helpers';

describe('the engines of a daemon', () => {
    test('the fake engine is always there, and every agent the registry knows is an ACP engine of its own id', () => {
        const registry = new AgentRegistry({ discovery: quietDiscovery() });
        const engines = createEngines(testConfig(), registry, {});

        expect(engines.get('fake')).toBeInstanceOf(FakeEngine);

        for (const id of ['claude', 'codex', 'cursor', 'opencode']) {
            expect(engines.has(id)).toBe(true);
            expect(engines.get(id)).toBeInstanceOf(AcpEngine);
            expect(engines.get(id)?.id).toBe(id);
        }

        expect(engines.get('claude')).toBe(engines.get('claude'));
        engines.stop();
    });

    test('an id nobody knows is no engine, and an agent added later is one without a restart', () => {
        const registry = new AgentRegistry({ discovery: quietDiscovery() });
        const engines = createEngines(testConfig(), registry, {});

        expect(engines.has('mine')).toBe(false);
        expect(engines.get('mine')).toBeUndefined();

        registry.add({ id: 'mine', name: 'Mine', command: '/usr/bin/mine', args: [] });

        expect(engines.has('mine')).toBe(true);
        expect(engines.get('mine')).toBeInstanceOf(AcpEngine);
        engines.stop();
    });

    test('the engines say whether their chats may fork: the fake one and Claude Code do, Codex and the other agents do not', () => {
        const registry = new AgentRegistry({ discovery: quietDiscovery() });
        const engines = createEngines(testConfig(), registry, {});

        expect(engines.get('fake')?.canFork).toBe(true);
        expect(engines.get('claude')?.canFork).toBe(true);

        for (const id of ['codex', 'cursor', 'opencode', 'gemini', 'copilot', 'grok', 'omp', 'hermes']) {
            expect(engines.get(id)?.canFork).toBe(false);
        }

        registry.add({ id: 'mine', name: 'Mine', command: '/usr/bin/mine', args: [] });
        expect(engines.get('mine')?.canFork).toBe(false);
        engines.stop();
    });

    test('the fake engine forks a session into a new one that goes on from the same turn', async () => {
        const fake = new FakeEngine(0);
        const first = await fake.fork({ sessionId: 'fake-a', ref: 'm1', cwd: '/tmp' });
        const second = await fake.fork({ sessionId: 'fake-a', ref: 'm1', cwd: '/tmp' });

        expect(first.sessionId).toStartWith('fake-');
        expect(first.sessionId).not.toBe('fake-a');
        expect(second.sessionId).not.toBe(first.sessionId);
        expect(new FakeEngine(0, false).canFork).toBe(false);
    });
});
