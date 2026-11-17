import { EventMapper } from '../src/engine/claude/mapper';

import type { SDKMessage, query as sdkQuery, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeConfig } from '../src/engine/claude/config';
import type { Totals } from '../src/engine/claude/mapper';
import type { EngineEvent } from '../src/engine/types';

export const claudeConfig: ClaudeConfig = {
    auth: 'subscription',
    permissionMode: 'bypassPermissions',
    settingSources: ['project'],
    maxSubagentDepth: 3,
    maxConcurrentSubagents: 20,
    debug: false,
};

/** Messages as the SDK emits them, reduced to the fields the adapter reads. */
export const message = (fields: Record<string, unknown>): SDKMessage => fields as unknown as SDKMessage;

export const init = (sessionId = 'session-1') => message({ type: 'system', subtype: 'init', session_id: sessionId, apiKeySource: 'none', model: 'haiku', claude_code_version: '1.0.0' });

export const assistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}) => message({ type: 'assistant', message: { id, role: 'assistant', content }, parent_tool_use_id: null, ...extra });

export const toolResult = (toolUseId: string, content: unknown, extra: Record<string, unknown> = {}) => message({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...extra }] },
    parent_tool_use_id: null,
});

export const delta = (text: string, index = 0, parent: string | null = null) => message({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }, parent_tool_use_id: parent });

export const streamEvent = (event: Record<string, unknown>, parent: string | null = null) => message({ type: 'stream_event', event, parent_tool_use_id: parent });

export const modelUsage = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20, costUSD: 0.01 };

/** A `result` message. `usage` and `modelUsage` are the session's cumulative totals, `cost` too. */
export function result(fields: Record<string, unknown> = {}, totals: { model?: Partial<typeof modelUsage>; cost?: number } = {}) {
    return message({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        total_cost_usd: totals.cost ?? 0.01,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 20, cache_read_input_tokens: 100 },
        modelUsage: { haiku: { ...modelUsage, ...totals.model } },
        ...fields,
    });
}

export function newMapper(options: { resumed?: boolean; totals?: Map<string, Totals>; auth?: ClaudeConfig['auth']; log?: (line: string) => void } = {}) {
    return new EventMapper({ auth: options.auth ?? 'subscription', resumed: options.resumed ?? false, totals: options.totals ?? new Map(), log: options.log });
}

/** Runs messages through a mapper and collects the events. */
export function mapAll(messages: SDKMessage[], mapper = newMapper()): EngineEvent[] {
    return messages.flatMap(item => mapper.map(item));
}

export const types = (events: EngineEvent[]) => events.map(event => event.type);

type QueryParams = Parameters<typeof sdkQuery>[0];

export interface FakeQuery {
    query: typeof sdkQuery;
    /** What each `query()` call was given. */
    calls: QueryParams[];
    /** The user messages each call's prompt delivered, as text. */
    received: string[][];
    closed: () => number;
}

/** A stand-in for the SDK's `query` that plays `script`. The prompt iterable is drained into `received`. */
export function fakeQuery(script: (params: QueryParams, received: string[]) => AsyncGenerator<SDKMessage>): FakeQuery {
    const calls: QueryParams[] = [];
    const received: string[][] = [];
    let closed = 0;

    const query = ((params: QueryParams) => {
        const inbox: string[] = [];

        calls.push(params);
        received.push(inbox);

        void (async () => {
            for await (const item of params.prompt as AsyncIterable<SDKUserMessage>) {
                inbox.push(item.message.content as string);
            }
        })();

        return Object.assign(script(params, inbox), {
            close: () => {
                closed += 1;
            },
            accountInfo: async () => ({ subscriptionType: 'Test plan', apiProvider: 'firstParty' }),
        });
    }) as unknown as typeof sdkQuery;

    return { query, calls, received, closed: () => closed };
}

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function until(condition: () => boolean, ms = 2000): Promise<void> {
    const deadline = Date.now() + ms;

    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error('Condition not met in time');
        }

        await sleep(5);
    }
}
