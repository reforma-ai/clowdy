/**
 * `clowdy`, the program an agent runs in its shell to use the runtime's commands (`clowdy thread spawn ...`). It reaches the daemon over the tool
 * bridge's loopback listener with the credential of the session it runs in (`CLOWDY_CLI_URL`, `CLOWDY_CLI_AUTH`, both set by the daemon for the agent
 * process), lists the commands the session may use (`GET /cli/tools`), and calls the one named (`POST /call`). It runs in the agent's process tree,
 * started by the shim the daemon writes (`shim.ts`), and imports nothing of the daemon's but the parser.
 */
import { readFileSync } from 'node:fs';
import { isatty } from 'node:tty';

import { commandOf, commandText, helpOf, parseCommand, STDIN, summaryOf, UsageError } from './args';

import type { CliTool } from './args';

/** The exit codes, which the help names too. */
export const EXIT = {
    done: 0,
    /** The daemon refused the call; its message says why. */
    refused: 1,
    /** A command line that cannot be understood. */
    usage: 2,
    /** The daemon cannot be reached, or does not know this session any more. */
    unreachable: 4,
} as const;

type Failure = 'refused' | 'usage' | 'unreachable';

export interface CliIo {
    env: Record<string, string | undefined>;
    fetch: typeof fetch;
    /** A file's text, or stdin's for `-`; rejects with a `UsageError` when it cannot be read. */
    readText(source: string): string | Promise<string>;
    stdout(text: string): void | Promise<void>;
    stderr(text: string): void | Promise<void>;
}

/**
 * Examples of the common flow, by the tool each one uses, in the order of the flow: the overview shows those of the tools the session has, and a
 * command's help its own. `test/cli.test.ts` checks them against the real tools.
 */
export const EXAMPLES: Readonly<Record<string, readonly string[]>> = {
    task_list: [
        'clowdy task list                                    # the work in flight; the counts of backlog and closed work come with it',
        'clowdy task list --ready                            # what can start now: every dependency is done or canceled',
        'clowdy task list --parent CLW-3                     # the open tasks inside CLW-3; --under lists every task below it, --roots the top level',
        'clowdy task list --status done --updated-since 7d   # closed work, when you need it',
        'clowdy task list --query "csv export"               # a text query searches closed tasks too: check before you create a duplicate',
        'clowdy task list --archived                         # the archive: closed work that was put away, whatever its status (--query searches it)',
        'clowdy task list --cursor <nextCursor>              # the next page of a long answer',
    ],
    task_get: ['clowdy task get CLW-3                                   # also names its parent, the tasks inside it, its checklist count and its latest comments'],
    task_create: [
        'clowdy task create "CSV export endpoint" --depends-on CLW-1,CLW-2 --description-file - <<\'EOF\'',
        '<Outcome, Owns, Needs, Check, Out of scope>',
        'EOF',
        'clowdy task create "Wire the button" --parent CLW-3                 # a task inside CLW-3, such as a stage of an epic',
    ],
    task_update: [
        'clowdy task update CLW-3 --status review',
        'clowdy task update CLW-3 --append "Verification passed: <what was run>"   # adds to the description; --description replaces it',
        'clowdy task update CLW-3 --add-depends-on CLW-5 --remove-depends-on CLW-2',
        'clowdy task update CLW-7 --parent CLW-3     # moves CLW-7, with the tasks inside it, under CLW-3',
        'clowdy task update CLW-7 --clear-parent     # makes it a top-level task again',
    ],
    task_comment: [
        'clowdy task comment CLW-3 "The cache key ignores the locale: fixed in the next commit"   # a note on the task, in Markdown',
        'clowdy task comment CLW-3 --body-file - <<\'EOF\'',
        '<a longer note: what you did, how it was checked, what is left>',
        'EOF',
    ],
    task_comments: [
        'clowdy task comments CLW-3                          # oldest first; task get shows only the last three, cut short',
        'clowdy task comments CLW-3 --cursor <nextCursor>    # the next page of a long thread',
    ],
    task_archive: [
        'clowdy task archive CLW-3 CLW-4          # closed tasks, each with the tasks inside it: they leave the board and every listing',
        'clowdy task archive CLW-3 --cancel       # an open task is refused without --cancel, which cancels the open ones in it first',
    ],
    task_unarchive: ['clowdy task unarchive CLW-3                          # brings it back with the tasks that were archived with it; task get still reads an archived task'],
    thread_spawn: [
        'clowdy thread spawn --title "Fix the login bug" --prompt-file - <<\'EOF\'',
        '<the whole brief: goal, what it owns, decisions made, how to check, how to report>',
        'EOF',
        '# then end your turn: the daemon sends you each thread\'s report when it stops',
    ],
    thread_tell: [
        'clowdy thread tell <thread> "Use the v2 endpoint instead"         # into its running turn when its agent can take it',
        'clowdy thread tell <thread> --mode queue "Then update the docs"  # its next turn',
    ],
    thread_wait: ['clowdy thread wait <thread> --timeout-seconds 60  # a short wait only'],
    thread_output: ['clowdy thread output <thread>'],
    thread_stop: ['clowdy thread stop <thread>'],
};

/** The commands, grouped, one line each, with the common flow, for `clowdy` and `clowdy <group>`. */
function overview(tools: readonly CliTool[], group?: string): string {
    const shown = tools.filter(tool => group === undefined || commandOf(tool).group === group);
    const names = shown.map(tool => `${ commandOf(tool).group } ${ commandOf(tool).command }`);
    const width = Math.max(...names.map(name => name.length)) + 2;
    const examples = Object.entries(EXAMPLES).flatMap(([name, lines]) => (shown.some(tool => tool.name === name) ? lines : []));

    return [
        `Usage: clowdy ${ group ?? '<group>' } <command> [arguments] [options]`,
        '',
        'The commands of this Clowdy session, run from your shell. Each one reaches the Clowdy daemon with the credential of your session.',
        '',
        'Commands:',
        ...shown.map((tool, index) => `  ${ names[index].padEnd(width) }${ commandText(summaryOf(tool.description), tools) }`),
        ...(examples.length > 0 ? ['', 'The common flow:', ...examples.map(example => `  ${ example }`)] : []),
        '',
        'Run clowdy <group> <command> --help for its arguments and options. A text option also takes --<name>-file <path>; a path of - reads stdin.',
        '--json prints one JSON object: {"ok":true,"result":...}, or {"ok":false,"error":{"code":"...","message":"..."}} when it fails.',
        'Exit codes: 0 done; 1 the daemon refused (its message says why); 2 a command line it cannot understand; 4 the daemon cannot be reached, or your session has ended.',
    ].join('\n');
}

/** Whether the command line asks for JSON, before the `--` that ends the options. */
function wantsJson(argv: readonly string[]): boolean {
    const end = argv.indexOf('--');

    return (end < 0 ? argv : argv.slice(0, end)).includes('--json');
}

const isHelp = (word: string | undefined) => word === 'help' || word === '--help' || word === '-h';

/** What a tool returned, as a value when it is JSON text and as the text when it is not. */
function parseResult(text: string): unknown {
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}

/**
 * Why the daemon could not be reached. A shell in a sandbox (Codex's) forbids every connection, loopback included, and says `EPERM`: the agent must run the
 * command again outside the sandbox, which it asks for with escalated permissions, so the message says so.
 */
function unreachable(error: unknown): string {
    const message = (error as Error).message;

    return `The Clowdy daemon could not be reached: ${ message }${ /EPERM|not permitted|sandbox/i.test(message) ? '. Your shell looks sandboxed, which forbids this connection: run the same command again with escalated permissions, outside the sandbox' : '' }`;
}

/** Runs one command line (`argv` without the program's name) and returns the exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
    const json = wantsJson(argv);
    const fail = async (failure: Failure, message: string): Promise<number> => {
        if (json) {
            await io.stdout(JSON.stringify({ ok: false, error: { code: failure, message } }));
        }

        await io.stderr(message);

        return EXIT[failure];
    };
    const base = io.env.CLOWDY_CLI_URL;
    const auth = io.env.CLOWDY_CLI_AUTH;

    if (!base || !auth) {
        return fail('unreachable', 'clowdy works only inside an agent session that Clowdy started: CLOWDY_CLI_URL and CLOWDY_CLI_AUTH are not set');
    }

    const headers = { authorization: `Bearer ${ auth }`, 'content-type': 'application/json' };
    const ended = 'The credential of this session is no longer valid: the agent session it belongs to has ended';
    let tools: CliTool[];

    try {
        const response = await io.fetch(`${ base }/cli/tools`, { headers });

        if (response.status === 401) {
            return await fail('unreachable', ended);
        }

        if (!response.ok) {
            return await fail('unreachable', `The Clowdy daemon did not list the commands (HTTP ${ response.status })`);
        }

        tools = (await response.json() as { tools: CliTool[] }).tools;
    }
    catch (error) {
        return fail('unreachable', unreachable(error));
    }

    // `clowdy`, `clowdy help` and `clowdy --help` list everything; `clowdy help <group> [<command>]` is `clowdy <group> [<command>] --help`.
    const words = isHelp(argv[0]) ? [...argv.slice(1), ...(argv.length > 1 ? ['--help'] : [])] : argv;
    const [group, command, ...rest] = words;

    if (group === undefined || isHelp(group) || (group === '--json' && command === undefined)) {
        await io.stdout(overview(tools));

        return EXIT.done;
    }

    if (!tools.some(tool => commandOf(tool).group === group)) {
        return fail('usage', `Unknown command "${ group }"\n\n${ overview(tools) }`);
    }

    if (command === undefined || isHelp(command)) {
        await io.stdout(overview(tools, group));

        return EXIT.done;
    }

    const tool = tools.find(candidate => commandOf(candidate).group === group && commandOf(candidate).command === command);

    if (!tool) {
        return fail('usage', `Unknown command "${ group } ${ command }"\n\n${ overview(tools, group) }`);
    }

    let input: Record<string, unknown>;

    try {
        const parsed = parseCommand(tool, rest);

        if (parsed.help) {
            await io.stdout(helpOf(tool, tools, EXAMPLES[tool.name]));

            return EXIT.done;
        }

        input = parsed.arguments;

        for (const [name, source] of Object.entries(parsed.files)) {
            input[name] = await io.readText(source);
        }
    }
    catch (error) {
        if (error instanceof UsageError) {
            return fail('usage', `${ error.message }\nRun clowdy ${ group } ${ command } --help for the usage`);
        }

        throw error;
    }

    let answer: { isError: boolean; text: string };

    try {
        // A call may be silent for as long as the tool takes (`thread wait`, up to 10 minutes), longer than Bun's idle limit of a request (5 minutes). The
        // daemon bounds every call, and ends the ones of a session that is over.
        const response = await io.fetch(`${ base }/call`, { method: 'POST', headers, body: JSON.stringify({ name: tool.name, arguments: input }), timeout: false });

        if (response.status === 401) {
            return await fail('unreachable', ended);
        }

        if (!response.ok) {
            return await fail('unreachable', `The Clowdy daemon did not take the call (HTTP ${ response.status }): ${ (await response.text()).slice(0, 500) }`);
        }

        answer = await response.json() as { isError: boolean; text: string };
    }
    catch (error) {
        return fail('unreachable', unreachable(error));
    }

    if (answer.isError) {
        return fail('refused', answer.text);
    }

    await io.stdout(json ? JSON.stringify({ ok: true, result: parseResult(answer.text) }) : answer.text);

    return EXIT.done;
}

/** How long stdin may stay silent without ending before a read of `-` gives up: an agent's shell may leave stdin open with nobody writing to it. */
const STDIN_IDLE_MS = 10_000;

/** What `readSource` reads stdin through; the process's own by default. */
export interface StdinSource {
    isTTY: boolean;
    stream(): ReadableStream<Uint8Array>;
}

const processStdin = (): StdinSource => ({ isTTY: isatty(0), stream: () => Bun.stdin.stream() });

/** Reads `reader` to its end, giving up when it stays silent for `idleMs`. */
async function readAll(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }, idleMs: number): Promise<string> {
    const decoder = new TextDecoder();
    let text = '';

    for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new UsageError(`Nothing came on stdin for ${ idleMs / 1000 } s and it did not end. Give the text with a heredoc (<<'EOF' ... EOF), a pipe that ends, or a file`)), idleMs);
        });
        const next = await Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));

        if (next.done) {
            return text + decoder.decode();
        }

        text += decoder.decode(next.value, { stream: true });
    }
}

/**
 * The text a `--<name>-file` option (or a bare `-`) names, without its trailing line breaks (a heredoc ends with one): a file's, or stdin's for `-`.
 * Stdin that is a terminal, that is empty, or that stays silent without ending is refused with a `UsageError`, so an agent never hangs on it.
 */
export async function readSource(source: string, stdin: StdinSource = processStdin(), idleMs = STDIN_IDLE_MS): Promise<string> {
    const trim = (text: string) => text.replace(/[\r\n]+$/, '');

    if (source !== STDIN) {
        try {
            return trim(readFileSync(source, 'utf8'));
        }
        catch (error) {
            throw new UsageError(`Cannot read ${ source }: ${ (error as Error).message }`);
        }
    }

    if (stdin.isTTY) {
        throw new UsageError('- reads the text from stdin, but stdin is a terminal and nothing is piped in. Give the text with a heredoc (<<\'EOF\' ... EOF), a pipe, or a file');
    }

    const reader = stdin.stream().getReader();
    let text: string;

    try {
        text = await readAll(reader, idleMs);
    }
    catch (error) {
        throw error instanceof UsageError ? error : new UsageError(`Cannot read stdin: ${ (error as Error).message }`);
    }
    finally {
        void reader.cancel().catch(() => undefined);
    }

    if (text.trim() === '') {
        throw new UsageError('- reads the text from stdin, but stdin was empty. Give the text with a heredoc (<<\'EOF\' ... EOF), a pipe, or a file');
    }

    return trim(text);
}

/** Writes all of `text` and a line break before the process exits, which a pipe of a large output needs; a reader that went away is no failure. */
async function write(target: typeof Bun.stdout, text: string): Promise<void> {
    try {
        await Bun.write(target, `${ text }\n`);
    }
    catch {
        // The reader closed the pipe (`clowdy thread log x | head -1`): nobody reads the rest.
    }
}

if (import.meta.main) {
    const idle = Number(process.env.CLOWDY_CLI_STDIN_IDLE_MS);
    const code = await runCli(process.argv.slice(2), {
        env: process.env,
        fetch,
        readText: source => readSource(source, processStdin(), idle > 0 ? idle : STDIN_IDLE_MS),
        stdout: text => write(Bun.stdout, text),
        stderr: text => write(Bun.stderr, text),
    });

    process.exit(code);
}
