import { afterAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { commandOf, flagsOf } from '../src/cli/args';
import { getProject } from '../src/db/projects';
import { toolsFor } from '../src/runs/tools';
import { defaultSystemSkillsSource } from '../src/skills/materialize';
import { cleanTempDirs, startHarness } from './helpers';

import type { ZodType } from 'zod';
import type { CliTool } from '../src/cli/args';

afterAll(cleanTempDirs);

/** The tools of the orchestrator that are not shell commands: `ask_user`, in semi-manual chats only. The skills, their README and `validate.ts` teach these and no others. */
const VOCABULARY = ['ask_user'];
/** Tools the daemon no longer has (spawned child runs are gone). A skill that names one teaches a call that fails. */
const REMOVED = ['run_spawn', 'run_inspect', 'run_wait', 'run_cancel', 'report_result'];
/**
 * What reads as a tool name in a skill. The prefixes include the removed tools' on purpose, so that naming one is caught, and the task and thread
 * tools', which the skills teach as `clowdy task`, `clowdy thread` and `clowdy chat` commands and never as tools.
 */
const TOOL_NAME = /\b(?:task|run|ask|report|thread|chat)_[a-z]+\b/g;
/** A Clowdy shell command as a skill writes it, with the rest of its line or code span, where its options are. */
const COMMAND = /\bclowdy (task|thread|chat) ([a-z][a-z-]*)([^`\n]*)/g;

/** The tool names a text mentions, once each, sorted. */
function toolNamesIn(text: string): string[] {
    return [...new Set(text.match(TOOL_NAME))].sort();
}

/** The shell commands a text runs (`task get`, `thread spawn`), once each, sorted. */
function commandsIn(text: string): string[] {
    return [...new Set([...text.matchAll(COMMAND)].map(match => `${match[1]} ${match[2]}`))].sort();
}

/** Every Markdown file of the system skills, with its text. */
function skillTexts(dir = join(defaultSystemSkillsSource(), 'skills')): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory()
            ? skillTexts(join(dir, entry.name))
            : entry.name.endsWith('.md')
              ? [readFileSync(join(dir, entry.name), 'utf8')]
              : []
    );
}

/**
 * The tools of the orchestrator of a semi-manual chat (the one with the most) that are not shell commands, by name, with their fields and schemas, and
 * its shell commands (`clowdy task <command>`, `clowdy thread <command>`, `clowdy chat read`) by group and command.
 */
async function daemonTools() {
    const h = await startHarness();

    try {
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { store, runs, threads } = h.daemon.services;
        const orchestrator = runs.createRun({
            project: getProject(store.db, project.id)!,
            role: 'orchestrator',
            chatId: chat.id,
            summary: 'Plan',
        });
        const fields = new Map<string, Set<string>>();
        const schemas = new Map<string, ZodType[]>();
        const commands = new Map<string, CliTool>();
        const tools = toolsFor({ store, runs, threads }, orchestrator, runs.modeOf(orchestrator));

        // The task, thread and chat tools are shell commands for the agent (`ToolDefinition.cli`); the skills teach them as `clowdy` commands, not as tools.
        for (const tool of tools.filter(candidate => !candidate.cli)) {
            fields.set(tool.name, new Set(Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>)));
            schemas.set(tool.name, [tool.schema]);
        }

        for (const tool of tools.filter(candidate => candidate.cli)) {
            const { group, command } = commandOf(tool);

            expect(['task', 'thread', 'chat']).toContain(group);
            commands.set(`${group} ${command}`, {
                ...tool,
                positional: [...(tool.cli?.positional ?? [])],
            } as unknown as CliTool);
        }

        return { fields, schemas, commands };
    } finally {
        await h.stop();
    }
}

describe('the system skills and the tools the daemon gives agents', () => {
    test('name the same tools: every tool is taught somewhere and nothing else is called a tool', async () => {
        expect(toolNamesIn(skillTexts().join('\n'))).toEqual(VOCABULARY);
    });

    test('give the orchestrator exactly the tools the skills teach', async () => {
        const { fields } = await daemonTools();

        expect([...fields.keys()].sort()).toEqual(VOCABULARY);
    });

    test('teach no tool that was removed, and catch one that comes back', () => {
        expect(toolNamesIn(skillTexts().join('\n')).filter(name => REMOVED.includes(name))).toEqual([]);

        for (const name of REMOVED) {
            expect(toolNamesIn(`Then call ${name}({ taskIds }) and wait.`)).toEqual([name]);
        }
    });

    test('teach every clowdy command the daemon has, no other, and catch one it does not have', async () => {
        const { commands } = await daemonTools();
        const taught = commandsIn(skillTexts().join('\n'));

        expect(taught).toEqual([...commands.keys()].sort());
        expect(
            commandsIn(
                'Then run `clowdy thread fork cht_1`, `clowdy task delete CLW-1` and `clowdy thread spawn --prompt-file -`.'
            )
        ).toEqual(['task delete', 'thread fork', 'thread spawn']);
        expect(commands.has('thread fork')).toBe(false);
        expect(commands.has('task delete')).toBe(false);
    });

    test('write only options a clowdy command has', async () => {
        const { commands } = await daemonTools();
        const uses = [...skillTexts().join('\n').matchAll(COMMAND)];

        expect(uses.filter(([, , , rest]) => rest.includes('--')).length).toBeGreaterThanOrEqual(4);

        for (const [use, group, command, rest] of uses) {
            const tool = commands.get(`${group} ${command}`);
            const flags = [...rest.matchAll(/(?:^|\s)--([a-z][a-z-]*)/g)].map(match => match[1]);
            const known = tool ? ['json', 'help', ...flagsOf(tool)] : [];

            expect({ use, unknown: flags.filter(flag => !known.includes(flag)) }).toEqual({ use, unknown: [] });
        }

        // An option named in a code span of its own (`--cwd`, `--mode queue`) is one of the commands' too, or a program's usual --help or --version.
        const anyCommand = new Set(['help', 'version', ...[...commands.values()].flatMap(flagsOf)]);
        const alone = (text: string) =>
            [...text.matchAll(/`--([a-z][a-z-]*)[^`]*`/g)].map(match => match[1]).filter(flag => !anyCommand.has(flag));

        expect(alone(skillTexts().join('\n'))).toEqual([]);

        // A misspelled option is caught.
        expect(flagsOf(commands.get('thread wait') as CliTool)).not.toContain('timeout');
        expect(flagsOf(commands.get('task update') as CliTool)).not.toContain('status-id');
        expect(alone('Pass `--timeout 60` or `--cwd <path>`.')).toEqual(['timeout']);
    });

    test('list the same commands in the validator of the skills package', async () => {
        const { commands } = await daemonTools();
        const source = readFileSync(join(defaultSystemSkillsSource(), 'scripts', 'validate.ts'), 'utf8');
        const listed = (group: string) =>
            [
                ...(
                    new RegExp(`const ${group.toUpperCase()}_COMMANDS = new Set\\(\\[([^\\]]*)\\]\\)`).exec(
                        source
                    )?.[1] ?? ''
                ).matchAll(/'([a-z-]+)'/g),
            ].map(match => `${group} ${match[1]}`);

        expect([...listed('task'), ...listed('thread'), ...listed('chat')].sort()).toEqual([...commands.keys()].sort());
    });

    test('list the same tools in the validator of the skills package', () => {
        const source = readFileSync(join(defaultSystemSkillsSource(), 'scripts', 'validate.ts'), 'utf8');
        const listed = [
            ...(/const TOOLS = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1] ?? '').matchAll(/'([a-z_]+)'/g),
        ].map(match => match[1]);

        expect(listed.sort()).toEqual(VOCABULARY);
    });

    test('write every ask_user card example so that the tool accepts it', async () => {
        const { schemas } = await daemonTools();
        const [schema] = schemas.get('ask_user') ?? [];
        const cards = [
            ...skillTexts()
                .join('\n')
                .matchAll(/^\s*ask_user\((\{[\s\S]*?\n\s*\})\)/gm),
        ];

        expect(cards.length).toBeGreaterThanOrEqual(1);

        for (const [, literal] of cards) {
            // The examples are plain object literals, so JavaScript can read them.
            const result = schema.safeParse(new Function(`return (${literal});`)());

            expect({ literal, ok: result.success }).toEqual({ literal, ok: true });
        }
    });
});
