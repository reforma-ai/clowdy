import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import { buildClaudeEnv } from './env';
import { classifyThrown } from './failure';
import { EventMapper } from './mapper';
import { spawnInOwnGroup } from './process';
import { createToolServer, MCP_SERVER, mcpToolName } from './tools';

import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EngineEvent, EngineSession, EngineStartOptions } from '../types';
import type { ClaudeConfig } from './config';
import type { Totals } from './mapper';

/**
 * The built-in tools of Claude Code that agents get. The rest stay off: `AskUserQuestion` and `ExitPlanMode` wait
 * for a person at a terminal, and the daemon has none; `ask_user` is the runtime's own way to ask.
 */
export const BUILT_IN_TOOLS = [
    'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'TaskStop', 'WebFetch', 'WebSearch', 'Agent', 'Skill', 'TodoWrite', 'NotebookEdit',
];

/** How long `close()` waits for the `claude` process to be gone. */
const CLOSE_WAIT_MS = 10_000;
const STDERR_TAIL_CHARS = 4000;

type Env = Record<string, string | undefined>;

/** What the `claude` process says about itself when a turn starts. */
export interface ClaudeDiagnostics {
    /** Where the request credential came from; `none` means the subscription login. */
    apiKeySource: string;
    claudeCodeVersion: string;
    model: string;
    subscriptionType?: string;
    apiProvider?: string;
}

export interface SessionDeps {
    config: ClaudeConfig;
    /** The daemon's own environment, which the agent's is built from. */
    env: Env;
    query: typeof sdkQuery;
    totals: Map<string, Totals>;
    /** The plugin directories a run loads: the system skills first, then the mirror of the user's skills. */
    pluginDirs(): string[];
    onInit(diagnostics: ClaudeDiagnostics): void;
}

/** The user messages of one session, in streaming-input mode: the prompt first, then whatever `send` adds. */
class Inbox {
    private queue: string[] = [];
    private wake?: () => void;
    private ended = false;

    /** Returns false when the inbox is closed and the message went nowhere. */
    push(text: string): boolean {
        if (this.ended) {
            return false;
        }

        this.queue.push(text);
        this.wake?.();

        return true;
    }

    end(): void {
        this.ended = true;
        this.wake?.();
    }

    async *messages(): AsyncGenerator<SDKUserMessage> {
        for (;;) {
            const text = this.queue.shift();

            if (text !== undefined) {
                yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
            }
            else if (this.ended) {
                return;
            }
            else {
                await new Promise<void>((resolve) => {
                    this.wake = resolve;
                });
                this.wake = undefined;
            }
        }
    }
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms).unref();
    });
}

/** One Claude Code process driven through the Agent SDK in streaming-input mode. */
export class ClaudeSession implements EngineSession {
    private inbox = new Inbox();
    private closing = new AbortController();
    private signal: AbortSignal;
    /** Events that do not come from an SDK message (the process started), delivered ahead of the next one. */
    private outOfBand: EngineEvent[] = [];
    private stderr = '';
    private exited: Promise<void> = Promise.resolve();

    constructor(private options: EngineStartOptions, private deps: SessionDeps) {
        this.signal = AbortSignal.any([options.signal, this.closing.signal]);
        this.inbox.push(options.prompt);
    }

    send(text: string): void {
        if (!this.inbox.push(text)) {
            console.warn('[clowdy] claude: a message arrived after the session ended and was dropped');
        }
    }

    /** Stops the session and waits until its `claude` process is gone. */
    async close(): Promise<void> {
        this.closing.abort();
        this.inbox.end();
        await Promise.race([this.exited, wait(CLOSE_WAIT_MS)]);
    }

    [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
        return this.run();
    }

    private async *run(): AsyncGenerator<EngineEvent> {
        if (this.signal.aborted) {
            return;
        }

        const { config, totals } = this.deps;
        const controller = new AbortController();
        const mapper = new EventMapper({
            auth: config.auth,
            totals,
            resumed: this.options.resumeSessionId !== undefined,
            log: config.debug ? line => console.debug(`[clowdy] claude: ${ line }`) : undefined,
        });
        let query: Query | undefined;

        this.signal.addEventListener('abort', () => {
            mapper.interrupted = true;
            controller.abort();
        }, { once: true });

        try {
            query = this.deps.query({ prompt: this.inbox.messages(), options: this.queryOptions(controller) });

            for await (const message of query) {
                yield* this.takeOutOfBand();

                if (this.signal.aborted) {
                    return;
                }

                this.observe(query, message);

                for (const event of mapper.map(message)) {
                    yield event;

                    if (event.type === 'done' || event.type === 'error') {
                        return;
                    }
                }
            }

            yield* this.takeOutOfBand();

            if (!this.signal.aborted) {
                yield { type: 'error', message: 'Claude Code ended without an answer.', retryable: true, code: 'process_crashed' };
            }
        }
        catch (error) {
            yield* this.takeOutOfBand();

            if (!this.signal.aborted) {
                const failure = classifyThrown(error, config.auth, this.stderr);

                yield { type: 'error', message: failure.message, retryable: failure.retryable, code: failure.code };
            }
        }
        finally {
            this.inbox.end();
            query?.close();
        }
    }

    private *takeOutOfBand(): Generator<EngineEvent> {
        yield* this.outOfBand.splice(0);
    }

    /** Reports what the process says about itself: who pays, and whether the system skills loaded. */
    private observe(query: Query, message: SDKMessage): void {
        if (message.type !== 'system' || message.subtype !== 'init') {
            return;
        }

        const { apiKeySource, claude_code_version: claudeCodeVersion, model } = message;

        for (const error of message.plugin_errors ?? []) {
            console.warn(`[clowdy] claude: plugin ${ error.path ?? error.plugin } did not load: ${ error.message }`);
        }

        query.accountInfo()
            .catch(() => undefined)
            .then(account => this.deps.onInit({ apiKeySource, claudeCodeVersion, model, subscriptionType: account?.subscriptionType, apiProvider: account?.apiProvider }));
    }

    private queryOptions(controller: AbortController): Options {
        const { config, env } = this.deps;
        const { tools, systemPrompt, cwd, model, resumeSessionId } = this.options;

        return {
            abortController: controller,
            cwd,
            env: buildClaudeEnv(config, env),
            model,
            resume: resumeSessionId,
            // Claude Code's own prompt is what makes the agent a capable engineer; the runtime's text is added to it.
            systemPrompt: { type: 'preset', preset: 'claude_code', ...(systemPrompt && { append: systemPrompt }) },
            permissionMode: config.permissionMode,
            ...(config.permissionMode === 'bypassPermissions' && { allowDangerouslySkipPermissions: true }),
            settingSources: config.settingSources,
            plugins: this.deps.pluginDirs().map(path => ({ type: 'local', path })),
            tools: BUILT_IN_TOOLS,
            allowedTools: [...BUILT_IN_TOOLS, ...tools.map(definition => mcpToolName(definition.name))],
            ...(tools.length > 0 && { mcpServers: { [MCP_SERVER]: createToolServer(tools, this.signal) } }),
            includePartialMessages: true,
            forwardSubagentText: true,
            agentProgressSummaries: true,
            pathToClaudeCodeExecutable: config.executable,
            spawnClaudeCodeProcess: spawnInOwnGroup({
                onSpawn: (pid, exited) => {
                    this.exited = exited;
                    this.outOfBand.push({ type: 'process', pid, ...(process.platform !== 'win32' && { pgid: pid }), startedAt: Date.now() });
                },
                onStderr: (text) => {
                    this.stderr = (this.stderr + text).slice(-STDERR_TAIL_CHARS);
                },
            }),
        };
    }
}
