import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolBridge } from '../src/engine/acp/bridge';
import { KNOWN_AGENTS } from '../src/engine/acp/catalog';
import { Discovery } from '../src/engine/acp/discovery';
import { AcpEngine } from '../src/engine/acp/engine';
import { AgentRegistry } from '../src/engine/acp/registry';
import { EngineFailure } from '../src/errors';
import { alive, collect, rig, tool } from './acp-helpers';

import type { Rig } from './acp-helpers';

let root: string;
let current: Rig | undefined;

/** A registry that finds no agent on this machine: neither on a path nor in an install folder, so no program of the person's is looked for or started. */
const emptyRegistry = () => new AgentRegistry({ discovery: new Discovery({ env: { PATH: '' }, loginPath: async () => undefined, installDirs: [] }) });

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clowdy-fork-'));
});

afterEach(() => {
    current?.stop();
    current = undefined;
    rmSync(root, { recursive: true, force: true });
});

const store = () => join(root, 'sessions');
const logFile = () => join(root, 'agent.log');

/** A v2 fake agent that forks, and keeps its sessions in a folder, as the adapters keep theirs on disk. */
const forking = (extra: Record<string, string> = {}, options: Parameters<typeof rig>[0] = {}) => (current = rig({ protocol: 'v2', agentEnv: { FAKE_ACP_FORK: '1', FAKE_ACP_STORE: store(), FAKE_ACP_LOG: logFile(), ...extra }, ...options }));

const lines = () => existsSync(logFile()) ? readFileSync(logFile(), 'utf8').split('\n').filter(Boolean) : [];

/** Runs one turn to its end, and gives back the session it ran in and the agent's id of each message the turn closed. */
async function turn(r: Rig, prompt: string, resumeSessionId?: string) {
    const { session } = r.start(prompt, { resumeSessionId });
    const events = await collect(session);

    await session.close();

    const sessionId = events.flatMap(event => event.type === 'session' ? [event.sessionId] : [])[0];
    const messageIds = events.flatMap(event => event.type === 'text' && event.done && event.messageId !== undefined ? [event.messageId] : []);
    const said = events.flatMap(event => event.type === 'text' ? [event.delta] : []).join('');

    return { events, sessionId, messageIds, said };
}

/** What the session's conversation is, as the fake agent's `history` directive says it. */
async function historyOf(r: Rig, sessionId: string): Promise<string> {
    return (await turn(r, 'history', sessionId)).said;
}

describe('a fork of an ACP session over v2', () => {
    test('copies the session up to the message the point names, inclusive, and the later turns are not in the copy', async () => {
        const r = forking();
        const first = await turn(r, 'say alpha');
        const second = await turn(r, 'say beta', first.sessionId);

        expect(second.sessionId).toBe(first.sessionId);
        expect(first.messageIds).toHaveLength(1);
        expect(second.messageIds).toHaveLength(1);

        const early = await r.engine.fork({ sessionId: first.sessionId, ref: first.messageIds[0], cwd: process.cwd() });
        const late = await r.engine.fork({ sessionId: first.sessionId, ref: second.messageIds[0], cwd: process.cwd() });

        expect(early.sessionId).not.toBe(first.sessionId);
        expect(late.sessionId).not.toBe(early.sessionId);

        const cut = await historyOf(r, early.sessionId);
        const whole = await historyOf(r, late.sessionId);

        expect(cut).toContain('assistant: alpha');
        expect(cut).not.toContain('beta');
        expect(whole).toContain('assistant: alpha');
        expect(whole).toContain('assistant: beta');
    });

    test('leaves the session it copied as it was, and a turn in the copy does not reach it', async () => {
        const r = forking();
        const first = await turn(r, 'say alpha');
        const second = await turn(r, 'say beta', first.sessionId);
        const forked = await r.engine.fork({ sessionId: first.sessionId, ref: first.messageIds[0], cwd: process.cwd() });

        await turn(r, 'say gamma', forked.sessionId);

        const source = await historyOf(r, first.sessionId);
        const copy = await historyOf(r, forked.sessionId);

        expect(second.messageIds).toHaveLength(1);
        expect(source).toContain('beta');
        expect(source).not.toContain('gamma');
        expect(copy).toContain('gamma');
        expect(copy).not.toContain('beta');
    });

    test('sends the fork point in the vendor extension, with the agent\'s own options, and closes the new session', async () => {
        const r = forking({ FAKE_ACP_DIRECTORIES: '1' }, { sessionMeta: { claudeCode: { options: { disallowedTools: ['AskUserQuestion'] } } } });
        const first = await turn(r, 'say alpha');
        const forked = await r.engine.fork({
            sessionId: first.sessionId,
            ref: first.messageIds[0],
            cwd: process.cwd(),
            additionalDirectories: ['/work/other'],
            systemPrompt: 'You work in Clowdy',
            tools: [tool('ping', async () => 'pong')],
        });
        const request = JSON.parse(lines().find(line => line.startsWith('fork-request '))?.slice('fork-request '.length) ?? 'null');

        expect(request).toMatchObject({
            cwd: process.cwd(),
            directories: ['/work/other'],
            servers: ['clowdy'],
            systemPrompt: 'You work in Clowdy',
            meta: { claudeCode: { options: { disallowedTools: ['AskUserQuestion'] } }, jetbrains: { air: { fork: { version: 1, messageId: first.messageIds[0] } } } },
        });
        expect(lines()).toContain(`fork ${ first.sessionId } ${ first.messageIds[0] } ${ forked.sessionId }`);
        expect(lines()).toContain(`close ${ forked.sessionId }`);
    });

    test('gives the agent the runtime\'s tools only for the call: their credential works while it forks and is dead once the call is over, a failed fork included', async () => {
        const r = forking();
        const first = await turn(r, 'say alpha');
        const credential = () => (lines().filter(line => line.startsWith('fork-bridge ')).at(-1) as string).split(' ');
        const status = ([, url, token]: string[]) => fetch(`${ url }/tools`, { headers: { authorization: `Bearer ${ token }` } }).then(answer => answer.status);
        const tools = [tool('ping', async () => 'pong')];

        await r.engine.fork({ sessionId: first.sessionId, ref: first.messageIds[0], cwd: process.cwd(), tools });
        expect(credential()[3]).toBe('200');
        expect(await status(credential())).toBe(401);

        await r.engine.fork({ sessionId: first.sessionId, ref: 'not-a-message', cwd: process.cwd(), tools }).catch(() => undefined);
        expect(lines().filter(line => line.startsWith('fork-bridge '))).toHaveLength(2);
        expect(credential()[3]).toBe('200');
        expect(await status(credential())).toBe(401);
    });

    test('sends no folders, prompt or tools the agent was not given, and no server when there are no tools', async () => {
        const r = forking();
        const first = await turn(r, 'say alpha');

        await r.engine.fork({ sessionId: first.sessionId, ref: first.messageIds[0], cwd: process.cwd() });

        const request = JSON.parse(lines().find(line => line.startsWith('fork-request '))?.slice('fork-request '.length) ?? 'null');

        expect(request.servers).toEqual([]);
        expect(request.directories).toBeUndefined();
        expect(request.systemPrompt).toBeUndefined();
    });

    test('ends the agent\'s process: nothing of the fork stays running once the call is over', async () => {
        const r = forking();
        const first = await turn(r, 'say alpha');

        await r.engine.fork({ sessionId: first.sessionId, ref: first.messageIds[0], cwd: process.cwd() });

        const pid = Number(lines().find(line => line.startsWith('fork-process '))?.slice('fork-process '.length));

        expect(pid).toBeGreaterThan(0);
        expect(alive(pid)).toBe(false);
    });

    test('a point the session does not have is refused with what the agent said, and the process is gone', async () => {
        const r = forking();
        const first = await turn(r, 'say alpha');
        const failure = await r.engine.fork({ sessionId: first.sessionId, ref: 'not-a-message', cwd: process.cwd() }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(EngineFailure);
        expect((failure as EngineFailure).message).toContain('Fork point message not-a-message was not found');
        expect(alive(Number(lines().find(line => line.startsWith('fork-process '))?.slice('fork-process '.length)))).toBe(false);
        expect(lines().some(line => line.startsWith('fork '))).toBe(false);
    });

    test('a session the agent no longer has fails as a lost session', async () => {
        const r = forking();
        const failure = await r.engine.fork({ sessionId: 'fake-gone', ref: 'm1', cwd: process.cwd() }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(EngineFailure);
        expect((failure as EngineFailure).code).toBe('session_not_found');
    });

    test('an adapter that offers no fork is refused without being asked for one', async () => {
        const r = forking({ FAKE_ACP_FORK: '' });
        const first = await turn(r, 'say alpha');
        const failure = await r.engine.fork({ sessionId: first.sessionId, ref: first.messageIds[0], cwd: process.cwd() }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(EngineFailure);
        expect((failure as EngineFailure).message).toContain('offers no session/fork');
        expect(lines().some(line => line.startsWith('fork-request '))).toBe(false);
    });

    test('an adapter that never answers is given up on after the time it was given, and its process is stopped', async () => {
        const r = forking({ FAKE_ACP_FORK: 'hang' }, { forkTimeoutMs: 300 });
        const first = await turn(r, 'say alpha');
        const started = Date.now();
        const failure = await r.engine.fork({ sessionId: first.sessionId, ref: first.messageIds[0], cwd: process.cwd() }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(EngineFailure);
        expect((failure as EngineFailure).message).toContain('did not finish the fork');
        expect(Date.now() - started).toBeLessThan(5000);
        expect(alive(Number(lines().find(line => line.startsWith('fork-process '))?.slice('fork-process '.length)))).toBe(false);
    });

    test('a fork that is cancelled stops at once', async () => {
        const r = forking({ FAKE_ACP_FORK: 'hang' });
        const first = await turn(r, 'say alpha');
        const abort = new AbortController();
        const pending = r.engine.fork({ sessionId: first.sessionId, ref: first.messageIds[0], cwd: process.cwd(), signal: abort.signal }).catch((error: unknown) => error);

        await new Promise(resolve => setTimeout(resolve, 300));
        abort.abort();

        const failure = await pending;

        expect(failure).toBeInstanceOf(EngineFailure);
        expect(alive(Number(lines().find(line => line.startsWith('fork-process '))?.slice('fork-process '.length)))).toBe(false);
    });

    test('an agent that is not installed fails as a missing agent', async () => {
        const registry = emptyRegistry();
        const bridge = new ToolBridge();

        try {
            const failure = await new AcpEngine('claude', { registry, bridge }).fork({ sessionId: 's', ref: 'm', cwd: process.cwd() }).catch((error: unknown) => error);

            expect(failure).toBeInstanceOf(EngineFailure);
            expect((failure as EngineFailure).code).toBe('engine_missing');
        }
        finally {
            bridge.stop();
        }
    });
});

describe('a fork of an ACP session over v1', () => {
    test('is refused, saying so, and no process is started', async () => {
        const r = (current = rig({ protocol: 'v1', agentEnv: { FAKE_ACP_LOG: logFile() } }));
        const failure = await r.engine.fork({ sessionId: 'fake-1', ref: 'm1', cwd: process.cwd() }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(EngineFailure);
        expect((failure as EngineFailure).message).toContain('cannot fork a conversation');
        expect((failure as EngineFailure).message).toContain('ACP v1');
        expect(existsSync(logFile())).toBe(false);
    });
});

describe('the fork flag of an agent', () => {
    test('Claude Code is flagged, and so is no agent that was not checked: Codex stays off until its pin forks for real, and every v1 agent is off', () => {
        expect(KNOWN_AGENTS.filter(spec => spec.fork).map(spec => spec.id)).toEqual(['claude']);
    });

    test('the registry says it for a built-in agent, and never for a custom one or one it does not know', () => {
        const registry = emptyRegistry();

        registry.add({ id: 'mine', name: 'Mine', command: 'my-agent', args: [] });

        expect(registry.canFork('claude')).toBe(true);
        expect(registry.canFork('codex')).toBe(false);
        expect(registry.canFork('cursor')).toBe(false);
        expect(registry.canFork('mine')).toBe(false);
        expect(registry.canFork('nobody')).toBe(false);
    });

    test('an engine takes its flag from its agent, whether or not the agent is installed', async () => {
        const registry = emptyRegistry();
        const bridge = new ToolBridge();

        try {
            expect(new AcpEngine('claude', { registry, bridge }).canFork).toBe(true);
            expect(new AcpEngine('cursor', { registry, bridge }).canFork).toBe(false);
        }
        finally {
            bridge.stop();
        }
    });
});
