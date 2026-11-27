import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProgram } from '../process/run';

import type { RunResult } from '../process/run';

/** Why a run that was asked for gave no text: it failed (the program, the login, the model, an answer that is not one) or did not end in time. */
export class GenerateFailure extends Error {
    constructor(readonly reason: 'failed' | 'timed_out') {
        super(reason === 'timed_out' ? 'The run did not end in time' : 'The run failed');
        this.name = 'GenerateFailure';
    }
}

/** The program of an agent as the daemon found it, and the environment a run of it gets (`AgentRegistry.probeTarget`: the person's own, minus the daemon's secrets and the agent's provider keys). */
export interface GenerateTarget {
    program: string;
    env: Record<string, string>;
}

/** A model call has this long to answer: the runs this serves take about 4 s. */
const RUN_TIMEOUT_MS = 30_000;

/** The most a run may print that is kept: its events are a few lines. */
const MAX_PRINTED_CHARS = 1024 * 1024;

/** What an agent's run for plain text is: the arguments its program takes, how its answer is read, and what it is told as instructions. */
interface Recipe {
    /** The one line that replaces the agent's own instructions. */
    instructions: string;
    /** `instructions` is given to the program as a file, written once into the data folder (Codex takes a path), and not inline. */
    asFile?: true;
    /** The arguments after the program. The prompt is on standard input. `instructions` is the text, or for a recipe `asFile` the absolute path of the file it is in. */
    args(instructions: string): string[];
    /** Variables the run has besides the agent's own environment. */
    env?: Record<string, string>;
    /** Variables of the agent's own environment the run does not get: the ones that would change what a run with no configuration does. */
    scrub?: RegExp;
    /** The text the run answered with, or `undefined` for a run that did not answer (a failure, or no message in what it printed). */
    answer(run: RunResult): string | undefined;
}

/**
 * Codex's `codex exec` with everything it lets go of switched off, as `.briefback/git-integration/research/spikes.md` (Spike A) measured it on `codex-cli 0.171.0`: the person's
 * config is ignored (`--ignore-user-config`, so no MCP servers, plugins or hooks, and the model and effort are set here), the cheapest model at low effort, no shell, no plan,
 * no agents, no skills list, no environment or permission blocks, no project documents, the built-in instructions replaced by one line, and nothing written to disk
 * (`--ephemeral`, a read-only sandbox). About 6.3K tokens and 4 s instead of 21.5K and 7.4 s. `exec` and `wait` stay in the request, which the model catalog forces. The features are
 * switched with `-c features.<name>=false`, which a Codex that has dropped one still takes (`--disable` stops with an error). `--ignore-user-config` also drops a gateway or
 * provider the person set in their `config.toml`: such a person gets no message, and the box says so.
 */
const INSTRUCTIONS = 'You write git commit messages. Reply with the single line asked for, nothing else.';

const codex: Recipe = {
    instructions: INSTRUCTIONS,
    asFile: true,
    args: instructions => [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '-s',
        'read-only',
        '--ignore-user-config',
        '--ignore-rules',
        '-m',
        'gpt-6-luna',
        '-c',
        'model_reasoning_effort=low',
        '-c',
        'agents.enabled=false',
        '-c',
        'tools.experimental_request_user_input.enabled=false',
        '-c',
        'tools.update_plan.enabled=false',
        '-c',
        'skills.include_instructions=false',
        '-c',
        'include_environment_context=false',
        '-c',
        'include_permissions_instructions=false',
        '-c',
        'include_collaboration_mode_instructions=false',
        '-c',
        'include_apps_instructions=false',
        '-c',
        'project_doc_max_bytes=0',
        // A TOML string: JSON's escapes are TOML's for a path.
        '-c',
        `model_instructions_file=${JSON.stringify(instructions)}`,
        '-c',
        'features.shell_tool=false',
        '-c',
        'features.sleep_tool=false',
        '-c',
        'features.view_image=false',
        '-c',
        'features.plugins=false',
        '-c',
        'features.apps=false',
        '-c',
        'features.goals=false',
        '--json',
        '-',
    ],
    answer: run => {
        if (run.code !== 0) return undefined;

        let answer: string | undefined;

        // One JSON event a line; the answer is the last finished `agent_message`, and a failed turn is no answer whatever came before it.
        for (const line of run.stdout.split('\n')) {
            let event: { type?: unknown; item?: { type?: unknown; text?: unknown } } | undefined;

            try {
                event = JSON.parse(line) as typeof event;
            } catch {
                continue;
            }

            if (event?.type === 'turn.failed') return undefined;

            if (
                event?.type === 'item.completed' &&
                event.item?.type === 'agent_message' &&
                typeof event.item.text === 'string'
            )
                answer = event.item.text;
        }

        return answer;
    },
};

/**
 * Claude Code's `claude -p` with every tool, MCP server, skill, hook, memory block and `CLAUDE.md` switched off and one line as the system prompt, as Spike A2 measured it on `claude`
 * 2.1.312 and `haiku` at low effort: 2.1K tokens and about 3 s, no tool schema in the request at all (Claude can drop every tool, Codex cannot). The settings are the person's own user
 * settings (`--setting-sources user`, so a login or gateway kept there still works) with auto memory and hooks off and every `CLAUDE.md` excluded. `--bare` is not used: it never reads the
 * subscription login. `MAX_THINKING_TOKENS=0` keeps the model from thinking (on the older `claude` 2.1.83 it was the difference of 24 s and 1.9 s), and **every `CLAUDE*` and `ANTHROPIC*`
 * variable is left out of the run's environment**: a daemon started from a Claude Code session carries `CLAUDE_CODE_ENTRYPOINT=claude-vscode`, which alone made the run load the claude.ai
 * connectors and cost 39K tokens, and a `CLAUDECODE` makes a nested `claude` behave as a sub-session. The price: a person whose login or gateway is set by such a variable
 * (`CLAUDE_CONFIG_DIR`, an API key, Bedrock or Vertex) gets no message from this agent, and the next one in the table is tried. The answer is the `result` of the JSON `claude` prints, and
 * `is_error` is a failure whatever the exit code says.
 */
const claude: Recipe = {
    instructions: INSTRUCTIONS,
    args: instructions => [
        '-p',
        '--output-format',
        'json',
        '--no-session-persistence',
        '--model',
        'haiku',
        '--effort',
        'low',
        '--tools',
        '',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--setting-sources',
        'user',
        '--settings',
        JSON.stringify({ autoMemoryEnabled: false, disableAllHooks: true, claudeMdExcludes: ['**/CLAUDE.md'] }),
        '--system-prompt',
        instructions,
    ],
    env: { MAX_THINKING_TOKENS: '0' },
    scrub: /^(?:CLAUDE|ANTHROPIC)/i,
    answer: run => {
        if (run.code !== 0) return undefined;

        let printed: unknown;

        try {
            printed = JSON.parse(run.stdout);
        } catch {
            return undefined;
        }

        // One result object; a client that streams prints an array of messages whose last is the result.
        const result = (
            Array.isArray(printed)
                ? printed.findLast(entry => (entry as { type?: unknown } | null)?.type === 'result')
                : printed
        ) as { is_error?: unknown; result?: unknown } | null | undefined;

        return result?.is_error !== true && typeof result?.result === 'string' ? result.result : undefined;
    },
};

/** The providers that can answer a request for text with no tools, by agent ID. */
const RECIPES: Record<string, Recipe> = { codex, claude };

export interface TextGenerationOptions {
    /** An agent's program and environment, or nothing for one that is off or not installed: `AgentRegistry.probeTarget`. */
    target(agentId: string): Promise<GenerateTarget | undefined>;
    /** Where the instructions file of an agent that takes one is written once. */
    dataDir: string;
    /** How long a run may take: 30 s. */
    timeoutMs?: number;
}

/**
 * Runs an agent once for a piece of text, with no tools, no session and none of the person's configuration (`Recipe`): a separate process in an empty folder of its own, the prompt on its
 * standard input, a limit of 30 s, ended when the daemon stops. Nothing here runs unless it is asked to, and the person's agent settings are never written. This is not an agent
 * session (`src/engine`): it has no chat, no run and no permission to ask.
 */
export class TextGeneration {
    readonly #options: TextGenerationOptions;
    readonly #stopper = new AbortController();
    /** The instructions files that are written, by agent. */
    readonly #files = new Map<string, Promise<string>>();

    constructor(options: TextGenerationOptions) {
        this.#options = options;
    }

    /** Ends the runs that are going on, and refuses new ones. */
    stop(): void {
        this.#stopper.abort();
    }

    /** Reads the agent's answer. A caller can check its permission again immediately before the prompt is sent. */
    async run(
        agentId: string,
        prompt: string,
        { signal, beforeStart }: { signal?: AbortSignal; beforeStart?: () => void } = {}
    ): Promise<string> {
        const stop = signal ? AbortSignal.any([signal, this.#stopper.signal]) : this.#stopper.signal;
        stop.throwIfAborted();
        const recipe = RECIPES[agentId];
        const target = recipe ? await this.#options.target(agentId) : undefined;

        if (!recipe || !target) throw new GenerateFailure('failed');

        const instructions = recipe.asFile
            ? await this.#instructionsOf(agentId, recipe).catch(() => undefined)
            : recipe.instructions;

        if (instructions === undefined) throw new GenerateFailure('failed');

        // Not a repository, so the agent reads no project's documents, and nothing of the person's folders is in reach.
        const cwd = await mkdtemp(join(tmpdir(), 'clowdy-generate-'));

        try {
            stop.throwIfAborted();
            beforeStart?.();

            const run = await runProgram(target.program, recipe.args(instructions), {
                env: {
                    ...Object.fromEntries(Object.entries(target.env).filter(([name]) => !recipe.scrub?.test(name))),
                    ...recipe.env,
                },
                cwd,
                timeoutMs: this.#options.timeoutMs ?? RUN_TIMEOUT_MS,
                maxChars: MAX_PRINTED_CHARS,
                input: prompt,
                signal: stop,
            });

            stop.throwIfAborted();
            if (run.timedOut) throw new GenerateFailure('timed_out');

            const answer = recipe.answer(run);

            if (answer === undefined || answer.trim() === '') throw new GenerateFailure('failed');

            return answer;
        } finally {
            await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    /** The file the agent's instructions are in, written when it is first asked for (and again if it is not what it should be). */
    #instructionsOf(agentId: string, recipe: Recipe): Promise<string> {
        let file = this.#files.get(agentId);

        if (!file) {
            const path = join(this.#options.dataDir, `${agentId}-commit-message-instructions.md`);

            file = (async () => {
                const kept = await readFile(path, 'utf8').catch(() => undefined);

                if (kept !== `${recipe.instructions}\n`) await writeFile(path, `${recipe.instructions}\n`);

                return path;
            })();
            // A write that failed is tried again by the next run.
            file.catch(() => this.#files.delete(agentId));
            this.#files.set(agentId, file);
        }

        return file;
    }
}
