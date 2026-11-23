import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID } from './fixtureData';
import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';

import type { Chat, ClowdyEvent, CommandResult, Run } from '@clowdy/protocol';
import type { CommandInput } from './transport';

describe('getAgentModels', () => {
    it('asks the daemon for the models of the agent, with its id escaped', async () => {
        const urls: string[] = [];
        const models = { state: 'ok', models: [{ id: 'opus', name: 'Opus 5.5', efforts: ['low', 'high'] }] };
        const fetchImpl = (async (input: RequestInfo | URL) => {
            urls.push(String(input));

            return new Response(JSON.stringify(models), { status: 200 });
        }) as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 't', fetch: fetchImpl });

        expect(await transport.getAgentModels('my agent')).toEqual(models);
        expect(urls).toEqual(['http://127.0.0.1:4310/v1/agents/my%20agent/models']);
    });

    it('fails when the daemon refuses', async () => {
        const transport = new HttpTransport({
            url: 'http://127.0.0.1:4310',
            token: 't',
            fetch: (async () => new Response('{}', { status: 500 })) as typeof fetch,
        });

        await expect(transport.getAgentModels('claude')).rejects.toMatchObject({ status: 500 });
    });

    it('serves the fixtures, each agent in its own spelling, and says so for an agent it does not know', async () => {
        const transport = new FixtureTransport({ timeline: false });
        const claude = await transport.getAgentModels('claude');
        const codex = await transport.getAgentModels('codex');

        expect(claude.models.find(model => model.isDefault)?.efforts).toEqual([
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
        ]);
        expect(codex.models.find(model => model.id === 'gpt-6-luna')?.efforts).not.toContain('ultra');
        expect(await transport.getAgentModels('nobody')).toMatchObject({ state: 'unavailable', models: [] });
    });

    it('lists a model with no reasoning levels and one with a single level, which the picker shows differently', async () => {
        const transport = new FixtureTransport({ timeline: false });
        const models = [
            ...(await transport.getAgentModels('claude')).models,
            ...(await transport.getAgentModels('codex')).models,
            ...(await transport.getAgentModels('cursor')).models,
        ];

        expect(models.some(model => model.efforts === undefined)).toBe(true);
        expect(models.some(model => model.efforts?.length === 1)).toBe(true);
    });

    it('hands out copies', async () => {
        const transport = new FixtureTransport({ timeline: false });

        (await transport.getAgentModels('claude')).models.length = 0;

        expect((await transport.getAgentModels('claude')).models.length).toBeGreaterThan(0);
    });
});

describe("the fixture daemon's chat model", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function connected(options: ConstructorParameters<typeof FixtureTransport>[0] = {}) {
        const transport = new FixtureTransport({ timeline: false, ...options });
        const { cursor } = await transport.getRootSnapshot();
        const events: ClowdyEvent[] = [];

        transport.subscribe(
            cursor,
            event => events.push(event),
            () => undefined
        );
        await vi.advanceTimersByTimeAsync(0);

        const run = async (command: CommandInput) => {
            const before = events.length;
            const result = await transport.command(command);

            await vi.advanceTimersByTimeAsync(0);

            return { result, events: events.slice(before).map(event => event.data) };
        };
        const chat = (result: CommandResult) => (result.ok ? (result.data as { chat: Chat }).chat : undefined);

        return { transport, run, chat };
    }

    it('makes a chat with the engine, model and level it is given, and refuses an agent the daemon does not know', async () => {
        const { run, chat } = await connected();
        const made = await run({
            type: 'chat.create',
            projectId: FIXTURE_PROJECT_ID,
            engine: 'codex',
            model: 'gpt-6-sol',
            effort: 'high',
        });

        expect(chat(made.result)).toMatchObject({ engine: 'codex', model: 'gpt-6-sol', effort: 'high' });
        expect(made.events).toEqual([{ type: 'chat.upserted', chat: chat(made.result) }]);

        const bare = await run({ type: 'chat.create', projectId: FIXTURE_PROJECT_ID });

        expect(chat(bare.result)).not.toHaveProperty('engine');

        const refused = await run({ type: 'chat.create', projectId: FIXTURE_PROJECT_ID, engine: 'nobody' });

        expect(refused.result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        expect(refused.events).toEqual([]);
    });

    it('changes the model and level of a chat, clears one with null, and drops a level when the model changes', async () => {
        const { run, chat } = await connected();
        const { id } = chat(
            (
                await run({
                    type: 'chat.create',
                    projectId: FIXTURE_PROJECT_ID,
                    engine: 'claude',
                    model: 'opus',
                    effort: 'max',
                })
            ).result
        )!;

        expect(chat((await run({ type: 'chat.setModel', chatId: id, effort: 'low' })).result)).toMatchObject({
            model: 'opus',
            effort: 'low',
        });
        expect(chat((await run({ type: 'chat.setModel', chatId: id, effort: null })).result)?.effort).toBeUndefined();

        await run({ type: 'chat.setModel', chatId: id, effort: 'low' });

        const sonnet = chat((await run({ type: 'chat.setModel', chatId: id, model: 'sonnet' })).result);

        expect(sonnet).toMatchObject({ engine: 'claude', model: 'sonnet' });
        expect(sonnet).not.toHaveProperty('effort');

        const named = chat((await run({ type: 'chat.setModel', chatId: id, model: 'opus', effort: 'high' })).result);

        expect(named).toMatchObject({ model: 'opus', effort: 'high' });
        expect(chat((await run({ type: 'chat.setModel', chatId: id, model: null })).result)).not.toHaveProperty(
            'model'
        );
        expect(chat((await run({ type: 'chat.setModel', chatId: id })).result)).not.toHaveProperty('effort');
    });

    it('keeps a level when the call clears a model the chat never had, as the daemon does', async () => {
        const { run, chat } = await connected();
        const { id } = chat(
            (await run({ type: 'chat.create', projectId: FIXTURE_PROJECT_ID, engine: 'claude', effort: 'max' })).result
        )!;

        expect(chat((await run({ type: 'chat.setModel', chatId: id, model: null })).result)).toMatchObject({
            effort: 'max',
        });
    });

    it("changes the provider only while the chat has no orchestrator, and then the old provider's model and level go", async () => {
        const { run, chat } = await connected();
        const { id } = chat(
            (
                await run({
                    type: 'chat.create',
                    projectId: FIXTURE_PROJECT_ID,
                    engine: 'claude',
                    model: 'opus',
                    effort: 'high',
                })
            ).result
        )!;

        expect(chat((await run({ type: 'chat.setModel', chatId: id, engine: 'claude' })).result)).toMatchObject({
            engine: 'claude',
            model: 'opus',
            effort: 'high',
        });

        const moved = chat((await run({ type: 'chat.setModel', chatId: id, engine: 'codex' })).result);

        expect(moved).toMatchObject({ engine: 'codex' });
        expect(moved).not.toHaveProperty('model');
        expect(moved).not.toHaveProperty('effort');
        expect(
            chat((await run({ type: 'chat.setModel', chatId: id, engine: 'cursor', model: 'composer-2.5' })).result)
        ).toMatchObject({ engine: 'cursor', model: 'composer-2.5' });

        await run({ type: 'chat.send', chatId: id, text: 'hello' });

        const refused = await run({ type: 'chat.setModel', chatId: id, engine: 'codex' });

        expect(refused.result).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(refused.events).toEqual([]);
        expect(chat((await run({ type: 'chat.setModel', chatId: id, engine: 'cursor' })).result)).toMatchObject({
            engine: 'cursor',
            model: 'composer-2.5',
        });
    });

    it('refuses an unknown chat and an unknown agent without changing anything', async () => {
        const { run, chat } = await connected();
        const { id } = chat(
            (await run({ type: 'chat.create', projectId: FIXTURE_PROJECT_ID, engine: 'claude', model: 'opus' })).result
        )!;
        const unknownChat = await run({ type: 'chat.setModel', chatId: 'c-none', model: 'opus' });
        const unknownEngine = await run({ type: 'chat.setModel', chatId: id, engine: 'nobody', model: 'sonnet' });

        expect(unknownChat.result).toMatchObject({ ok: false, error: { code: 'not_found' } });
        expect(unknownEngine.result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        expect([...unknownChat.events, ...unknownEngine.events]).toEqual([]);
        expect(chat((await run({ type: 'chat.setModel', chatId: id })).result)).toMatchObject({
            engine: 'claude',
            model: 'opus',
        });
    });

    it('announces nothing and moves nothing when the call changes nothing', async () => {
        const { run, chat } = await connected();
        const made = chat(
            (
                await run({
                    type: 'chat.create',
                    projectId: FIXTURE_PROJECT_ID,
                    engine: 'claude',
                    model: 'opus',
                    effort: 'high',
                })
            ).result
        )!;

        await vi.advanceTimersByTimeAsync(5000);

        for (const same of [
            {},
            { model: 'opus' },
            { effort: 'high' },
            { engine: 'claude', model: 'opus', effort: 'high' },
        ]) {
            const again = await run({ type: 'chat.setModel', chatId: made.id, ...same });

            expect(again.events).toEqual([]);
            expect(chat(again.result)).toEqual(made);
        }
    });

    it('carries the choice to the orchestrator run, announcing the run and the chat once, and nothing for a call that changes nothing', async () => {
        const { run, chat, transport } = await connected();
        const { id } = chat(
            (
                await run({
                    type: 'chat.create',
                    projectId: FIXTURE_PROJECT_ID,
                    engine: 'codex',
                    model: 'gpt-6-sol',
                    effort: 'high',
                })
            ).result
        )!;
        const sent = await run({ type: 'chat.send', chatId: id, text: 'hello' });
        const orchestrator = (changed: ClowdyEvent['data'][]) =>
            changed.find((data): data is { type: 'run.upserted'; run: Run } => data.type === 'run.upserted')?.run;
        const started = orchestrator(sent.events);

        // The first message starts the orchestrator on what the chat holds.
        expect(started).toMatchObject({ role: 'orchestrator', engine: 'codex', model: 'gpt-6-sol', effort: 'high' });

        const changed = await run({ type: 'chat.setModel', chatId: id, model: 'gpt-6-luna', effort: 'low' });

        expect(changed.events.map(data => data.type).sort()).toEqual(['chat.upserted', 'run.upserted']);
        expect(orchestrator(changed.events)).toMatchObject({
            id: started?.id,
            engine: 'codex',
            model: 'gpt-6-luna',
            effort: 'low',
        });
        expect(chat(changed.result)).toMatchObject({ engine: 'codex', model: 'gpt-6-luna', effort: 'low' });

        const cleared = await run({ type: 'chat.setModel', chatId: id, effort: null });

        expect(orchestrator(cleared.events)).toMatchObject({ model: 'gpt-6-luna' });
        expect(orchestrator(cleared.events)).not.toHaveProperty('effort');
        expect(
            (await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).runs.find(
                candidate => candidate.id === started?.id
            )
        ).not.toHaveProperty('effort');

        const same = await run({ type: 'chat.setModel', chatId: id, model: 'gpt-6-luna' });

        expect(same.events).toEqual([]);
    });

    describe('compacting a chat', () => {
        const orchestrator = (changed: ClowdyEvent['data'][]) =>
            changed.find((data): data is { type: 'run.upserted'; run: Run } => data.type === 'run.upserted')?.run;

        it('refuses a chat that is unknown, has no conversation yet, or has an agent with no compact command, and changes nothing', async () => {
            const { run, chat } = await connected();
            const none = chat((await run({ type: 'chat.create', projectId: FIXTURE_PROJECT_ID })).result)!;
            const cursor = chat(
                (await run({ type: 'chat.create', projectId: FIXTURE_PROJECT_ID, engine: 'cursor' })).result
            )!;

            await run({ type: 'chat.send', chatId: cursor.id, text: 'hello' });

            const refusals = await Promise.all([
                run({ type: 'chat.compact', chatId: 'c-none' }),
                run({ type: 'chat.compact', chatId: none.id }),
                run({ type: 'chat.compact', chatId: cursor.id }),
            ]);

            expect(refusals.map(refusal => (refusal.result.ok ? 'ok' : refusal.result.error.code))).toEqual([
                'not_found',
                'invalid',
                'invalid',
            ]);
            expect(refusals[1].result).toMatchObject({
                error: { message: 'This chat has no conversation to compact yet' },
            });
            expect(refusals[2].result).toMatchObject({
                error: { message: 'Cursor has no command to compact its conversation' },
            });
            expect(refusals.flatMap(refusal => refusal.events)).toEqual([]);
        });

        it('plays a compact turn for an orchestrator that has finished: the compaction call, then what it saved and a lower reading', async () => {
            const data = createFixtureData();
            const finished = data.runs.find(candidate => candidate.id === 'r-orch-2')!;

            finished.context = { used: 53_000, size: 250_000 };

            const { run, transport } = await connected({ data });
            const before = (await transport.getItems({ runId: 'r-orch-2' })).length;
            const compacted = await run({ type: 'chat.compact', chatId: 'c-2' });

            expect(compacted.result).toMatchObject({ ok: true, data: { chatId: 'c-2', runId: 'r-orch-2' } });
            expect(orchestrator(compacted.events)).toMatchObject({ id: 'r-orch-2', status: 'running' });

            const running = await transport.getItems({ runId: 'r-orch-2' });

            // No bubble: the person wrote nothing.
            expect(running).toHaveLength(before + 1);
            expect(running.at(-1)?.body).toMatchObject({ kind: 'tool', name: 'compact', state: 'running' });

            await vi.advanceTimersByTimeAsync(1500);

            const done = (await transport.getItems({ runId: 'r-orch-2' })).at(-1)?.body;

            expect(done).toMatchObject({ kind: 'tool', name: 'compact', state: 'done' });
            expect(JSON.parse(String(done?.kind === 'tool' && done.output))).toMatchObject({
                preTokens: 53_000,
                postTokens: 13_250,
            });

            const after = (await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).runs.find(
                candidate => candidate.id === 'r-orch-2'
            );

            expect(after).toMatchObject({ status: 'succeeded', context: { used: 13_250, size: 250_000 } });
        });

        it('queues a compact item for an orchestrator that works, once, and runs it when the orchestrator has finished', async () => {
            const { run, transport } = await connected();
            const chatOf = async () =>
                (await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).chats.find(
                    candidate => candidate.id === 'c-1'
                )!;

            expect((await run({ type: 'chat.compact', chatId: 'c-1' })).result).toMatchObject({
                ok: true,
                data: { chatId: 'c-1', runId: 'r-orch-1' },
            });
            expect((await run({ type: 'chat.compact', chatId: 'c-1' })).events).toEqual([]);
            expect((await chatOf()).queue).toEqual([
                {
                    id: expect.any(String),
                    mode: 'queue',
                    command: 'compact',
                    text: 'Compact the conversation',
                    content: '/compact',
                    createdAt: expect.any(Number),
                },
            ]);

            const [item] = (await chatOf()).queue!;

            // Send now steers nothing while the orchestrator works.
            expect((await run({ type: 'chat.sendQueued', chatId: 'c-1', itemId: item.id })).events).toEqual([]);

            // Stop holds it; Send now then runs it as a compact turn.
            await run({ type: 'run.cancel', runId: 'r-orch-1' });
            expect((await chatOf()).queuePaused).toBe('stopped');
            await run({ type: 'chat.sendQueued', chatId: 'c-1', itemId: item.id });
            expect((await chatOf()).queue).toBeUndefined();
            expect((await transport.getItems({ runId: 'r-orch-1' })).at(-1)?.body).toMatchObject({
                kind: 'tool',
                name: 'compact',
                state: 'running',
            });
        });

        it('ends the calls a stopped orchestrator left running', async () => {
            const { run, transport } = await connected();

            expect(
                (await transport.getItems({ runId: 'r-orch-1' })).some(
                    item => item.body.kind === 'tool' && item.body.state === 'running'
                )
            ).toBe(true);

            await run({ type: 'run.cancel', runId: 'r-orch-1' });

            const tools = (await transport.getItems({ runId: 'r-orch-1' })).flatMap(item =>
                item.body.kind === 'tool' ? [item.body] : []
            );

            expect(tools.filter(body => body.state === 'running')).toEqual([]);
            expect(tools.find(body => body.toolCallId === 'tc-agent-2')).toMatchObject({
                state: 'error',
                error: 'Stopped before it finished',
            });
        });

        it('leaves a run that has no reading without one', async () => {
            const { run } = await connected();
            const compacted = await run({ type: 'chat.compact', chatId: 'c-2' });

            expect(compacted.result.ok).toBe(true);
            expect(orchestrator(compacted.events)).not.toHaveProperty('context');
        });
    });

    it('starts an orchestrator that is on what the chat holds, and on nothing it was not given', async () => {
        const { run, chat } = await connected();
        const bare = chat((await run({ type: 'chat.create', projectId: FIXTURE_PROJECT_ID })).result)!;
        const sent = await run({ type: 'chat.send', chatId: bare.id, text: 'hello' });
        const started = sent.events.find(
            (data): data is { type: 'run.upserted'; run: Run } => data.type === 'run.upserted'
        )?.run;

        expect(started).toMatchObject({ role: 'orchestrator' });
        expect(started).not.toHaveProperty('model');
        expect(started).not.toHaveProperty('effort');
    });
});
