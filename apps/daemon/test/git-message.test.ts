import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { startDaemon } from '../src/daemon';
import { buildPrompt, cleanSubject, DIFF_EXCERPT_BYTES, FILE_LIST_BYTES, MAX_SUBJECT_COLUMNS, nameStatus, shareExcerpt } from '../src/git/message';
import { WriteEnvironment } from '../src/git/writeEnv';
import { claude } from '../src/providers/claude';
import { codex } from '../src/providers/codex';
import { GenerateFailure, TextGeneration } from '../src/providers/generate';
import { ProvidersService } from '../src/providers/service';
import { cleanTempDirs, git, Harness, makeRepo, tempDir, testAgents, testConfig } from './helpers';

import type { SignInStatus } from '@clowdy/protocol';
import type { Config } from '../src/config';

afterAll(cleanTempDirs);

const posix = process.platform !== 'win32';
/** The stand-in `codex` is a POSIX shell script: on Windows these cases are skipped, not run against another program. */
const withStandIn = posix ? describe : describe.skip;

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

const json = async <T>(response: Response) => await response.json() as T;

interface Failure { ok: false; error: { code: string; message: string; details?: { reason?: string } } }

describe('cleanSubject', () => {
    test('keeps the first line of the answer, and takes off the quotes round it and the period at its end', () => {
        expect(cleanSubject('feat(files): add fresh\n')).toBe('feat(files): add fresh');
        expect(cleanSubject('\n  fix(auth): handle an empty token.  \n\nThe body goes here')).toBe('fix(auth): handle an empty token');
        expect(cleanSubject('"chore: update dependencies"')).toBe('chore: update dependencies');
        expect(cleanSubject('`docs: describe the tab`')).toBe('docs: describe the tab');
        expect(cleanSubject('fix: handle `null` in the list')).toBe('fix: handle `null` in the list');
    });

    test('cuts a line over the limit at the last whole word, and a line with no word to cut at where it is', () => {
        const long = 'feat(changes): add the commit box with a message field and a button that writes the message';

        expect(long.length).toBeGreaterThan(MAX_SUBJECT_COLUMNS);

        const cut = cleanSubject(long) as string;

        expect(cut.length).toBeLessThanOrEqual(MAX_SUBJECT_COLUMNS);
        expect(long.startsWith(cut)).toBe(true);
        // The cut is at a space: the word after it was not started.
        expect(long[cut.length]).toBe(' ');
        expect(cleanSubject('x'.repeat(100))).toBe('x'.repeat(MAX_SUBJECT_COLUMNS));

        // A word that ends exactly at the limit is whole.
        const exact = `${ 'a'.repeat(MAX_SUBJECT_COLUMNS - 5) } word extra`;

        expect(cleanSubject(exact)).toBe(`${ 'a'.repeat(MAX_SUBJECT_COLUMNS - 5) } word`);
    });

    test('counts a character once, whatever its bytes', () => {
        expect(cleanSubject(`fix: ${ 'é'.repeat(MAX_SUBJECT_COLUMNS - 5) }`)).toBe(`fix: ${ 'é'.repeat(MAX_SUBJECT_COLUMNS - 5) }`);
    });

    test('says nothing for an answer with no text', () => {
        expect(cleanSubject('')).toBeUndefined();
        expect(cleanSubject('  \n \n')).toBeUndefined();
        expect(cleanSubject('""')).toBeUndefined();
    });
});

describe('shareExcerpt', () => {
    test('keeps a small file whole and gives what it leaves to the big ones', () => {
        const small = 'diff --git a/s b/s\n+one\n+two';
        const big = Array.from({ length: 200 }, (_, index) => `+line number ${ index }`).join('\n');
        const huge = Array.from({ length: 2000 }, (_, index) => `+another line ${ index }`).join('\n');
        const shared = shareExcerpt([huge, small, big], 600);

        expect(Buffer.byteLength(shared)).toBeLessThanOrEqual(600 + 2);
        expect(shared).toContain(small);
        // Each of the two big ones got a share, so neither starved the other; the cut is at a whole line.
        expect(shared).toContain('+line number 0');
        expect(shared).toContain('+another line 0');
        expect(shared.split('\n').every(line => line.startsWith('+') || line.startsWith('diff'))).toBe(true);
    });

    test('is everything when it fits, in the order given', () => {
        expect(shareExcerpt(['a\nb', 'c'], 100)).toBe('a\nb\nc');
        expect(shareExcerpt([], 100)).toBe('');
    });
});

describe('nameStatus', () => {
    test('lists the files as git does, the old and the new name of a rename, what cannot be shown noted, and cut at its budget', () => {
        const files = [
            { path: 'a.ts', kind: 'modified' as const, revision: '' },
            { path: 'new name.ts', oldPath: 'old name.ts', kind: 'renamed' as const, revision: '' },
            { path: 'logo.png', kind: 'added' as const, binary: true as const, revision: '' },
            { path: 'big.json', kind: 'modified' as const, tooLarge: true as const, revision: '' },
            { path: 'gone.ts', kind: 'deleted' as const, revision: '' },
        ];

        expect(nameStatus(files)).toBe('M\ta.ts\nR\told name.ts\tnew name.ts\nA\tlogo.png (binary)\nM\tbig.json (too large to show)\nD\tgone.ts');

        const many = Array.from({ length: 1000 }, (_, index) => ({ path: `src/file-${ index }.ts`, kind: 'modified' as const, revision: '' }));
        const cut = nameStatus(many);

        expect(Buffer.byteLength(cut)).toBeLessThan(FILE_LIST_BYTES + 100);
        expect(cut).toMatch(/\.\.\. and \d+ more files$/);
    });
});

describe('buildPrompt', () => {
    test('asks for one Conventional Commits subject and carries the files, the excerpt and the style of the history', () => {
        const prompt = buildPrompt({ files: [{ path: 'a.ts', kind: 'modified', revision: '' }], excerpt: 'diff --git a/a.ts b/a.ts\n+x', recent: ['feat(daemon): read a place', 'fix: handle null'] });

        expect(prompt).toContain('type(scope): description');
        expect(prompt).toContain('at most 72 characters');
        expect(prompt).toContain('- feat(daemon): read a place\n- fix: handle null');
        expect(prompt).toContain('Changed files:\nM\ta.ts');
        expect(prompt).toContain('diff --git a/a.ts b/a.ts\n+x');
    });

    test('leaves out a section it has nothing for', () => {
        const prompt = buildPrompt({ files: [{ path: 'a.ts', kind: 'added', revision: '' }], excerpt: '', recent: [] });

        expect(prompt).not.toContain('Recent subjects');
        expect(prompt).not.toContain('Excerpt of the diff');
    });
});

withStandIn('TextGeneration', () => {
    test('is no run at all for an agent it has no recipe for, or one that is not installed', async () => {
        const dataDir = tempDir('git-message');
        const missing = new TextGeneration({ target: async () => undefined, dataDir });

        // Codex first, then Claude Code: the order the first that is on and signed in is asked in.
        expect(missing.agents).toEqual(['codex', 'claude']);
        await expect(missing.run('codex', 'prompt')).rejects.toBeInstanceOf(GenerateFailure);
        await expect(missing.run('claude', 'prompt')).rejects.toMatchObject({ reason: 'failed' });
        await expect(new TextGeneration({ target: async () => ({ program: '/bin/true', env: {} }), dataDir }).run('cursor', 'prompt')).rejects.toMatchObject({ reason: 'failed' });
    });
});

/**
 * A stand-in `codex` or `claude`: it answers what `answer.jsonl` holds (the `--json` events of a Codex turn, or the one JSON object `claude -p` prints), and records how it was
 * called: its arguments, what it was given on standard input, where it ran and which of the variables a run must not have (or must have) it was started with.
 */
function agentStandIn(name: 'codex' | 'claude' = 'codex') {
    const dir = tempDir('git-message');
    const program = join(dir, name);
    const file = (item: string) => join(dir, item);

    writeFileSync(program, [
        '#!/bin/sh',
        'PATH=/usr/bin:/bin',
        `dir='${ dir }'`,
        `if [ "$1" = "--version" ]; then echo "${ name === 'codex' ? 'codex-cli 0.171.0' : '2.1.312 (Claude Code)' }"; exit 0; fi`,
        'echo run >> "$dir/count"',
        ': > "$dir/argv"',
        'for arg in "$@"; do printf \'%s\\n\' "$arg" >> "$dir/argv"; done',
        'cat > "$dir/stdin"',
        'pwd -P > "$dir/cwd"',
        'ls -A | wc -l | tr -d " " > "$dir/cwd-entries"',
        'env | cut -d= -f1 > "$dir/env-names"',
        'env | grep -E \'^(CLAUDE|ANTHROPIC|MAX_THINKING)\' | sort > "$dir/env-seen"',
        'if [ -f "$dir/sleep" ]; then sleep "$(cat "$dir/sleep")"; fi',
        'cat "$dir/answer.jsonl"',
        'exit "$(cat "$dir/exit" 2>/dev/null || echo 0)"',
    ].join('\n'));
    chmodSync(program, 0o755);

    const events = (text: string) => [
        { type: 'thread.started', thread_id: 't1' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } },
        { type: 'turn.completed', usage: { input_tokens: 6293, output_tokens: 17 } },
    ].map(event => JSON.stringify(event)).join('\n');
    const result = (text: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, usage: { input_tokens: 3, output_tokens: 25 } });

    return {
        dir,
        program,
        /** What the stand-in answers: the events of a Codex turn that ended with this message, or the result Claude prints. */
        answer(text: string) {
            writeFileSync(file('answer.jsonl'), name === 'codex' ? events(text) : result(text));
        },
        /** The raw lines it prints instead. */
        say(...lines: string[]) {
            writeFileSync(file('answer.jsonl'), lines.join('\n'));
        },
        exit(code: number) {
            writeFileSync(file('exit'), String(code));
        },
        sleep(seconds: number) {
            writeFileSync(file('sleep'), String(seconds));
        },
        /** How many times it was run to answer (a `--version` is not one). */
        get runs() {
            return existsSync(file('count')) ? readFileSync(file('count'), 'utf8').trim().split('\n').length : 0;
        },
        read: (name: string) => readFileSync(file(name), 'utf8'),
    };
}

/** What a test says of an agent: whether the person turned `Commit messages` on for it, and whether it is signed in. */
interface AgentState {
    on?: boolean;
    signedIn?: SignInStatus;
}

/**
 * A daemon whose Codex and Claude Code are stand-in programs. Codex is on and signed in unless the test says otherwise (`on`, `signedIn`, the options of Codex); Claude Code is off and
 * signed in unless `claude` says otherwise, so a test of the first agent alone is not about the second.
 */
async function start(options: AgentState & { timeoutMs?: number; config?: Partial<Config>; claude?: AgentState } = {}) {
    const standIn = agentStandIn('codex');
    const claudeStandIn = agentStandIn('claude');
    const config = testConfig(options.config);
    const agents = testAgents(config);
    const state = { signIn: options.signedIn ?? 'signed-in', claudeSignIn: options.claude?.signedIn ?? 'signed-in' };
    const providers = new ProvidersService({
        registry: agents,
        announce: () => undefined,
        providers: [
            { spec: codex.spec, read: async () => ({ signIn: { status: state.signIn }, usage: { state: 'unavailable', windows: [] } }) },
            { spec: claude.spec, read: async () => ({ signIn: { status: state.claudeSignIn }, usage: { state: 'unavailable', windows: [] } }) },
        ],
    });
    const textGeneration = options.timeoutMs === undefined ? undefined : new TextGeneration({ target: id => agents.probeTarget(id), dataDir: config.dataDir, timeoutMs: options.timeoutMs });
    const h = new Harness(await startDaemon(config, { agents, providers, textGeneration, gitEnvironment: new WriteEnvironment({ env: () => ({ ...process.env, SHELL: '/usr/bin/true' }) }) }), config);

    harnesses.push(h);
    standIn.answer('feat(files): add fresh');
    claudeStandIn.answer('fix(files): add fresh');
    h.ok('agent.update', { id: 'codex', path: standIn.program, ...(options.on !== false && { settings: { commitMessage: true } }) });
    h.ok('agent.update', { id: 'claude', path: claudeStandIn.program, ...(options.claude?.on === true && { settings: { commitMessage: true } }) });

    const path = makeRepo(tempDir('git-message'));

    git(path, 'config', 'user.name', 'Test');
    git(path, 'config', 'user.email', 'test@example.com');
    mkdirSync(join(path, 'src'), { recursive: true });
    writeFileSync(join(path, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
    writeFileSync(join(path, 'b.txt'), 'b\n');
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', 'feat(src): add the first files');

    const { project } = h.ok('project.add', { folders: [path] });
    const folderId = project.folders[0].id as string;
    const generate = (paths: unknown) => h.fetch(`/v1/projects/${ project.id }/git/message`, { method: 'POST', body: JSON.stringify({ folderId, paths }) });

    return { h, config, standIn, claudeStandIn, state, providers, path, project, folderId, generate };
}

withStandIn('POST /v1/projects/:id/git/message', () => {
    test('runs Codex as the spike settled it, with the files, an excerpt of their diff and the recent subjects on its standard input, and answers one line', async () => {
        const { h, config, standIn, path, generate } = await start();

        writeFileSync(join(path, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 3;\nexport const c = 4;\n');
        writeFileSync(join(path, 'fresh.txt'), 'brand new\nsecond line\n');
        writeFileSync(join(path, 'b.txt'), 'b changed, not ticked\n');

        // Listing the agents (which reads their versions and accounts) runs no model.
        await h.fetch('/v1/agents');
        expect(standIn.runs).toBe(0);

        const response = await generate(['src/a.ts', 'fresh.txt']);

        expect(response.status).toBe(200);
        expect(await json<{ message: string }>(response)).toEqual({ message: 'feat(files): add fresh' });
        expect(standIn.runs).toBe(1);

        const instructions = join(config.dataDir, 'codex-commit-message-instructions.md');

        expect(standIn.read('argv').trimEnd().split('\n')).toEqual([
            'exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--ignore-user-config', '--ignore-rules',
            '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=low',
            '-c', 'agents.enabled=false',
            '-c', 'tools.experimental_request_user_input.enabled=false',
            '-c', 'tools.update_plan.enabled=false',
            '-c', 'skills.include_instructions=false',
            '-c', 'include_environment_context=false',
            '-c', 'include_permissions_instructions=false',
            '-c', 'include_collaboration_mode_instructions=false',
            '-c', 'include_apps_instructions=false',
            '-c', 'project_doc_max_bytes=0',
            '-c', `model_instructions_file=${ JSON.stringify(instructions) }`,
            '-c', 'features.shell_tool=false', '-c', 'features.sleep_tool=false', '-c', 'features.view_image=false',
            '-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'features.goals=false',
            '--json', '-',
        ]);
        expect(readFileSync(instructions, 'utf8').trim()).toBe('You write git commit messages. Reply with the single line asked for, nothing else.');

        const prompt = standIn.read('stdin');

        expect(prompt).toContain('Changed files:\nM\tsrc/a.ts\nA\tfresh.txt');
        // The diff of the file git tracks, and the text of the new one as a diff of it.
        expect(prompt).toContain('+export const c = 4;');
        expect(prompt).toContain('-export const b = 2;');
        expect(prompt).toContain('+++ b/fresh.txt\n@@ -0,0 +1,2 @@\n+brand new\n+second line');
        // What was not ticked is not sent.
        expect(prompt).not.toContain('b.txt');
        expect(prompt).not.toContain('not ticked');
        expect(prompt).toContain('- feat(src): add the first files\n- Initial commit');

        // The run is in an empty folder of its own, which is gone after it, not in the repository; the daemon's secrets are not in its environment.
        const cwd = standIn.read('cwd').trim();

        expect(cwd).not.toContain(path);
        expect(standIn.read('cwd-entries').trim()).toBe('0');
        expect(existsSync(cwd)).toBe(false);
        expect(standIn.read('env-names')).not.toMatch(/^CLOWDY_/m);
    });

    test('trims a line that is too long at a word, and takes a message that came with quotes, a period or a body', async () => {
        const { standIn, path, generate } = await start();

        writeFileSync(join(path, 'b.txt'), 'changed\n');
        standIn.answer('feat(changes): add the commit box with a message field and a button that writes the message\n\nA body.');

        const long = (await json<{ message: string }>(await generate(['b.txt']))).message;

        expect(long.length).toBeLessThanOrEqual(72);
        expect(long.startsWith('feat(changes): add the commit box with a message field')).toBe(true);
        expect(long).not.toMatch(/\s$/);
        // The model is not asked again.
        expect(standIn.runs).toBe(1);

        standIn.answer('"fix(a): quoted."');
        expect(await json<{ message: string }>(await generate(['b.txt']))).toEqual({ message: 'fix(a): quoted' });
    });

    test('is an error with the daemon\'s own words, and never the program\'s, when the run fails', async () => {
        const { standIn, path, generate } = await start();

        writeFileSync(join(path, 'b.txt'), 'changed\n');

        const refused = async () => {
            const response = await generate(['b.txt']);
            const body = await json<Failure>(response);

            expect(response.status).toBe(503);
            expect(body.error).toMatchObject({ code: 'unavailable', message: 'Couldn\'t write the message', details: { reason: 'failed' } });

            return body;
        };

        standIn.exit(1);
        await refused();
        standIn.exit(0);
        standIn.say(JSON.stringify({ type: 'turn.started' }), JSON.stringify({ type: 'turn.failed', error: { message: 'The model gpt-6-luna does not exist, key sk-secret-123' } }));
        expect(JSON.stringify(await refused())).not.toContain('sk-secret');
        standIn.say('not json', JSON.stringify({ type: 'turn.completed' }));
        await refused();
        standIn.answer('   ');
        await refused();

        // The box is as it was and the next try runs again.
        standIn.answer('fix: it works now');
        expect(await json<{ message: string }>(await generate(['b.txt']))).toEqual({ message: 'fix: it works now' });
    });

    test('is an error with the reason when the run does not end in time', async () => {
        const { standIn, path, generate } = await start({ timeoutMs: 500 });

        writeFileSync(join(path, 'b.txt'), 'changed\n');
        standIn.sleep(20);

        const started = Date.now();
        const response = await generate(['b.txt']);

        expect(response.status).toBe(503);
        expect((await json<Failure>(response)).error).toMatchObject({ message: 'Couldn\'t write the message', details: { reason: 'timed_out' } });
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    test('refuses and runs nothing while Commit messages is off, and while the agent that has it on is signed out', async () => {
        const off = await start({ on: false });

        writeFileSync(join(off.path, 'b.txt'), 'changed\n');

        const refused = await off.generate(['b.txt']);

        expect(refused.status).toBe(400);
        expect((await json<Failure>(refused)).error).toMatchObject({ code: 'invalid', message: 'Couldn\'t write the message', details: { reason: 'off' } });
        expect(off.standIn.runs).toBe(0);

        // The switch is the person's: turning it on is what lets the daemon run it, and turning it off stops it again.
        off.h.ok('agent.update', { id: 'codex', settings: { commitMessage: true } });
        expect((await off.generate(['b.txt'])).status).toBe(200);
        off.h.ok('agent.update', { id: 'codex', settings: { commitMessage: false } });
        expect((await off.generate(['b.txt'])).status).toBe(400);
        expect(off.standIn.runs).toBe(1);

        const out = await start({ signedIn: 'signed-out' });

        writeFileSync(join(out.path, 'b.txt'), 'changed\n');

        const signedOut = await out.generate(['b.txt']);

        expect(signedOut.status).toBe(503);
        expect((await json<Failure>(signedOut)).error).toMatchObject({ code: 'unavailable', message: 'Couldn\'t write the message', details: { reason: 'signed_out' } });
        expect(out.standIn.runs).toBe(0);

        // Signing in is noticed by the next ask.
        out.state.signIn = 'signed-in';
        out.providers.forget('codex');
        expect((await out.generate(['b.txt'])).status).toBe(200);
        expect(out.standIn.runs).toBe(1);

        // An account the daemon could not read is not a yes.
        out.state.signIn = 'unknown';
        out.providers.forget('codex');
        expect((await out.generate(['b.txt'])).status).toBe(503);
    });

    test('judges the paths as a commit does, before anything is run', async () => {
        const { standIn, path, generate, h } = await start();

        writeFileSync(join(path, 'b.txt'), 'changed\n');

        for (const paths of [[], ['src/a.ts'], ['../x'], ['b.txt', 'nothing.txt'], 'b.txt', undefined]) {
            const response = await generate(paths);

            expect(response.status).toBe(400);
        }

        expect(standIn.runs).toBe(0);
        expect((await fetch(`${ h.url }/v1/projects/x/git/message`, { method: 'POST', body: '{}' })).status).toBe(401);
        expect((await h.fetch('/v1/projects/prj_unknown/git/message', { method: 'POST', body: JSON.stringify({ folderId: 'fld_x', paths: ['b.txt'] }) })).status).toBe(404);
    });

    test('asks once at a time for a place, shares one answer between identical requests and queues a different one behind it', async () => {
        const { standIn, path, generate } = await start();

        writeFileSync(join(path, 'b.txt'), 'changed\n');
        writeFileSync(join(path, 'c.txt'), 'new\n');
        standIn.sleep(0.6);

        const [one, two, other] = await Promise.all([generate(['b.txt']), generate(['b.txt']), generate(['c.txt'])]);

        expect([one.status, two.status, other.status]).toEqual([200, 200, 200]);
        expect(await json<{ message: string }>(one)).toEqual(await json<{ message: string }>(two));
        // The two identical requests were one run; the different one had its own, after it.
        expect(standIn.runs).toBe(2);
    });

    test('names a file it cannot show, and keeps its excerpt to a budget shared among the files', async () => {
        const { standIn, path, generate } = await start();
        const lines = (prefix: string, count: number) => `${ Array.from({ length: count }, (_, index) => `${ prefix } line ${ index } ${ 'x'.repeat(60) }`).join('\n') }\n`;

        writeFileSync(join(path, 'huge.ts'), lines('huge', 3000));
        writeFileSync(join(path, 'big.ts'), lines('big', 400));
        writeFileSync(join(path, 'small.ts'), 'export const small = true;\n');
        writeFileSync(join(path, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]));
        await generate(['huge.ts', 'big.ts', 'small.ts', 'logo.png']);

        const prompt = standIn.read('stdin');
        const excerpt = prompt.slice(prompt.indexOf('Excerpt of the diff'));

        expect(Buffer.byteLength(excerpt)).toBeLessThan(DIFF_EXCERPT_BYTES + 400);
        expect(prompt).toContain('A\tlogo.png (binary)');
        expect(excerpt).not.toContain('logo.png');
        // The small file is whole and neither big one starved the other.
        expect(excerpt).toContain('+export const small = true;');
        expect(excerpt).toContain('+huge line 0 ');
        expect(excerpt).toContain('+big line 0 ');
        expect(excerpt).toContain('+big line 100 ');
    });

    test('writes its instructions once, and sends the run an environment without the provider\'s keys', async () => {
        const { standIn, config, path, generate } = await start();
        const before = process.env.OPENAI_API_KEY;

        process.env.OPENAI_API_KEY = 'sk-test-not-a-key';
        writeFileSync(join(path, 'b.txt'), 'changed\n');

        try {
            await generate(['b.txt']);

            const file = join(config.dataDir, 'codex-commit-message-instructions.md');
            const written = statSync(file).mtimeMs;

            await generate(['b.txt']);
            expect(statSync(file).mtimeMs).toBe(written);
            expect(standIn.runs).toBe(2);
            // The run uses the person's login, never a key from the daemon's environment.
            expect(standIn.read('env-names')).not.toMatch(/^OPENAI_API_KEY$/m);
        }
        finally {
            if (before === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = before;
        }
    });

    test('leaves the repository as it found it: nothing staged, nothing committed', async () => {
        const { standIn, path, generate } = await start();

        writeFileSync(join(path, 'b.txt'), 'changed\n');
        writeFileSync(join(path, 'fresh.txt'), 'new\n');

        const head = git(path, 'rev-parse', 'HEAD');
        const status = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: path, stdout: 'pipe' }).stdout.toString();

        expect((await generate(['b.txt', 'fresh.txt'])).status).toBe(200);
        expect(standIn.runs).toBe(1);
        expect(git(path, 'rev-parse', 'HEAD')).toBe(head);
        expect(Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: path, stdout: 'pipe' }).stdout.toString()).toBe(status);
        expect(dirname(standIn.read('cwd').trim())).not.toBe(path);
    });
});

withStandIn('Claude Code as the second agent for the message', () => {
    /** What the person's own shell, or the Claude Code session that started the daemon, leaves in its environment. */
    const LEAKED = { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', CLAUDE_CONFIG_DIR: '/tmp/claude-config', ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_MODEL: 'opus', MAX_THINKING_TOKENS: '31999' };

    /** Runs `work` with the daemon's own environment holding what a Claude Code session leaves, and puts it back. */
    async function withLeakedEnvironment<T>(work: () => Promise<T>): Promise<T> {
        const before = Object.fromEntries(Object.keys(LEAKED).map(name => [name, process.env[name]]));

        Object.assign(process.env, LEAKED);

        try {
            return await work();
        }
        finally {
            for (const [name, value] of Object.entries(before)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    }

    test('runs `claude -p` as Spike A2 recommends, in an empty folder, with the prompt on its standard input and no CLAUDE or ANTHROPIC variable in its environment', async () => {
        const { claudeStandIn, standIn, path, generate } = await start({ on: false, claude: { on: true } });

        writeFileSync(join(path, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 3;\n');
        writeFileSync(join(path, 'fresh.txt'), 'brand new\n');

        const response = await withLeakedEnvironment(() => generate(['src/a.ts', 'fresh.txt']));

        expect(response.status).toBe(200);
        expect(await json<{ message: string }>(response)).toEqual({ message: 'fix(files): add fresh' });
        expect(claudeStandIn.runs).toBe(1);
        expect(standIn.runs).toBe(0);
        expect(claudeStandIn.read('argv').trimEnd().split('\n')).toEqual([
            '-p', '--output-format', 'json', '--no-session-persistence',
            '--model', 'haiku', '--effort', 'low',
            '--tools', '', '--strict-mcp-config', '--disable-slash-commands',
            '--setting-sources', 'user',
            '--settings', '{"autoMemoryEnabled":false,"disableAllHooks":true,"claudeMdExcludes":["**/CLAUDE.md"]}',
            '--system-prompt', 'You write git commit messages. Reply with the single line asked for, nothing else.',
        ]);

        const prompt = claudeStandIn.read('stdin');

        expect(prompt).toContain('Changed files:\nM\tsrc/a.ts\nA\tfresh.txt');
        expect(prompt).toContain('+export const b = 3;');
        expect(prompt).toContain('- feat(src): add the first files');

        // Not one variable of Claude Code or of the API reaches the run, whatever the daemon was started from, and thinking is off.
        expect(claudeStandIn.read('env-seen').trim()).toBe('MAX_THINKING_TOKENS=0');
        expect(claudeStandIn.read('env-names')).not.toMatch(/^(CLAUDE|ANTHROPIC)/m);

        const cwd = claudeStandIn.read('cwd').trim();

        expect(cwd).not.toContain(path);
        expect(claudeStandIn.read('cwd-entries').trim()).toBe('0');
        expect(existsSync(cwd)).toBe(false);
    });

    test('is asked when Codex has the switch off, or is signed out, and is not asked while Codex answers', async () => {
        const first = await start({ claude: { on: true } });

        writeFileSync(join(first.path, 'b.txt'), 'changed\n');
        expect(await json<{ message: string }>(await first.generate(['b.txt']))).toEqual({ message: 'feat(files): add fresh' });
        expect(first.standIn.runs).toBe(1);
        expect(first.claudeStandIn.runs).toBe(0);

        const off = await start({ on: false, claude: { on: true } });

        writeFileSync(join(off.path, 'b.txt'), 'changed\n');
        expect(await json<{ message: string }>(await off.generate(['b.txt']))).toEqual({ message: 'fix(files): add fresh' });
        expect(off.standIn.runs).toBe(0);

        const out = await start({ signedIn: 'signed-out', claude: { on: true } });

        writeFileSync(join(out.path, 'b.txt'), 'changed\n');
        expect(await json<{ message: string }>(await out.generate(['b.txt']))).toEqual({ message: 'fix(files): add fresh' });
        expect(out.standIn.runs).toBe(0);
        expect(out.claudeStandIn.runs).toBe(1);
    });

    test('is asked once when the run of Codex fails, says nothing, or does not end in time, and its answer is the one that comes back', async () => {
        const failing = await start({ claude: { on: true } });

        writeFileSync(join(failing.path, 'b.txt'), 'changed\n');
        failing.standIn.exit(1);
        expect(await json<{ message: string }>(await failing.generate(['b.txt']))).toEqual({ message: 'fix(files): add fresh' });
        expect(failing.standIn.runs).toBe(1);
        expect(failing.claudeStandIn.runs).toBe(1);

        const silent = await start({ claude: { on: true } });

        writeFileSync(join(silent.path, 'b.txt'), 'changed\n');
        silent.standIn.answer('   ');
        expect(await json<{ message: string }>(await silent.generate(['b.txt']))).toEqual({ message: 'fix(files): add fresh' });
        expect(silent.claudeStandIn.runs).toBe(1);

        const slow = await start({ claude: { on: true }, timeoutMs: 500 });

        writeFileSync(join(slow.path, 'b.txt'), 'changed\n');
        slow.standIn.sleep(20);

        const started = Date.now();

        expect(await json<{ message: string }>(await slow.generate(['b.txt']))).toEqual({ message: 'fix(files): add fresh' });
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(slow.claudeStandIn.runs).toBe(1);
    });

    test('is an error with the daemon\'s own words when both fail, each asked once, and when the only agent that is on fails there is no other to ask', async () => {
        const both = await start({ claude: { on: true } });

        writeFileSync(join(both.path, 'b.txt'), 'changed\n');
        both.standIn.exit(1);
        both.claudeStandIn.say(JSON.stringify({ type: 'result', is_error: true, result: 'The model haiku does not exist, key sk-secret-456' }));

        const response = await both.generate(['b.txt']);
        const body = await json<Failure>(response);

        expect(response.status).toBe(503);
        expect(body.error).toMatchObject({ code: 'unavailable', message: 'Couldn\'t write the message', details: { reason: 'failed' } });
        expect(JSON.stringify(body)).not.toContain('sk-secret');
        expect([both.standIn.runs, both.claudeStandIn.runs]).toEqual([1, 1]);

        // A claude that prints something that is not its result, or fails with a code, or an empty answer, is one that failed.
        for (const printed of ['not json', JSON.stringify([{ type: 'system' }]), JSON.stringify({ type: 'result', is_error: false, result: ' ' })]) {
            both.claudeStandIn.say(printed);
            expect((await both.generate(['b.txt'])).status).toBe(503);
        }

        both.claudeStandIn.exit(1);
        both.claudeStandIn.answer('fix: fine, but the exit code says no');
        expect((await both.generate(['b.txt'])).status).toBe(503);

        const alone = await start({ on: false, claude: { on: true }, timeoutMs: 500 });

        writeFileSync(join(alone.path, 'b.txt'), 'changed\n');
        alone.claudeStandIn.sleep(20);

        const timedOut = await alone.generate(['b.txt']);

        expect(timedOut.status).toBe(503);
        expect((await json<Failure>(timedOut)).error.details).toEqual({ reason: 'timed_out' });
        expect(alone.claudeStandIn.runs).toBe(1);
        expect(alone.standIn.runs).toBe(0);
    });

    test('is not asked, and the route refuses, while its switch is off and Codex\'s is too, or when it is on and signed out and Codex is off', async () => {
        const off = await start({ on: false });

        writeFileSync(join(off.path, 'b.txt'), 'changed\n');

        const refused = await off.generate(['b.txt']);

        expect(refused.status).toBe(400);
        expect((await json<Failure>(refused)).error.details).toEqual({ reason: 'off' });
        expect([off.standIn.runs, off.claudeStandIn.runs]).toEqual([0, 0]);

        const out = await start({ on: false, claude: { on: true, signedIn: 'signed-out' } });

        writeFileSync(join(out.path, 'b.txt'), 'changed\n');

        const signedOut = await out.generate(['b.txt']);

        expect(signedOut.status).toBe(503);
        expect((await json<Failure>(signedOut)).error.details).toEqual({ reason: 'signed_out' });
        expect(out.claudeStandIn.runs).toBe(0);
    });

    test('trims an answer over 72 characters at the last word that fits, takes the first line, and the quotes and the period off', async () => {
        const { claudeStandIn, path, generate } = await start({ on: false, claude: { on: true } });

        writeFileSync(join(path, 'b.txt'), 'changed\n');
        claudeStandIn.answer('"feat(changes): add the commit box with a message field and a button that writes the message."\n\nA body that is not wanted.');

        const message = (await json<{ message: string }>(await generate(['b.txt']))).message;

        expect(message.length).toBeLessThanOrEqual(72);
        expect(message.startsWith('feat(changes): add the commit box with a message field')).toBe(true);
        expect(message).not.toMatch(/["\s.]$/);
        // The model is not asked again for a shorter one.
        expect(claudeStandIn.runs).toBe(1);
    });
});
