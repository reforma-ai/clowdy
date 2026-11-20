import { afterAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getProject } from '../src/db/projects';
import { toolsFor } from '../src/runs/tools';
import { defaultSystemSkillsSource } from '../src/skills/materialize';
import { cleanTempDirs, startHarness } from './helpers';

import type { ZodType } from 'zod';

afterAll(cleanTempDirs);

/** The tools of the orchestrator, `ask_user` in semi-manual chats only. The skills, their README and `validate.ts` teach these and no others. */
const VOCABULARY = ['ask_user', 'task_create', 'task_get', 'task_list', 'task_update'];
/** Tools the daemon no longer has (spawned child runs are gone). A skill that names one teaches a call that fails. */
const REMOVED = ['run_spawn', 'run_inspect', 'run_wait', 'run_cancel', 'report_result'];
/** What reads as a tool name in a skill. The prefixes include the removed tools' on purpose, so that naming one is caught. */
const TOOL_NAME = /\b(?:task|run|ask|report)_[a-z]+\b/g;

/** The tool names a text mentions, once each, sorted. */
function toolNamesIn(text: string): string[] {
    return [...new Set(text.match(TOOL_NAME))].sort();
}

/** Every Markdown file of the system skills, with its text. */
function skillTexts(dir = join(defaultSystemSkillsSource(), 'skills')): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => (
        entry.isDirectory() ? skillTexts(join(dir, entry.name)) : entry.name.endsWith('.md') ? [readFileSync(join(dir, entry.name), 'utf8')] : []
    ));
}

/** The tools of the orchestrator of a semi-manual chat (the one with the most), by name, with their fields and schemas. */
async function daemonTools() {
    const h = await startHarness();

    try {
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { store, runs } = h.daemon.services;
        const orchestrator = runs.createRun({ project: getProject(store.db, project.id)!, role: 'orchestrator', chatId: chat.id, summary: 'Plan' });
        const fields = new Map<string, Set<string>>();
        const schemas = new Map<string, ZodType[]>();

        for (const tool of toolsFor({ store, runs }, orchestrator, runs.modeOf(orchestrator))) {
            fields.set(tool.name, new Set(Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>)));
            schemas.set(tool.name, [tool.schema]);
        }

        return { fields, schemas };
    }
    finally {
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
            expect(toolNamesIn(`Then call ${ name }({ taskIds }) and wait.`)).toEqual([name]);
        }
    });

    test('list the same tools in the validator of the skills package', () => {
        const source = readFileSync(join(defaultSystemSkillsSource(), 'scripts', 'validate.ts'), 'utf8');
        const listed = [...(/const TOOLS = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map(match => match[1]);

        expect(listed.sort()).toEqual(VOCABULARY);
    });

    test('use only fields a tool has when they write a call as `tool({ field, field })`', async () => {
        const { fields } = await daemonTools();
        const calls = [...skillTexts().join('\n').matchAll(/\b([a-z]+_[a-z]+)\(\{([^}\n]*)\}\)/g)];

        expect(calls.length).toBeGreaterThanOrEqual(4);

        for (const [, name, list] of calls) {
            const used = list.split(',').map(part => /^\s*(\w+)/.exec(part)?.[1]).filter(Boolean);

            expect({ name, unknown: used.filter(field => !fields.get(name)?.has(field as string)) }).toEqual({ name, unknown: [] });
        }
    });

    test('write every ask_user card example so that the tool accepts it', async () => {
        const { schemas } = await daemonTools();
        const [schema] = schemas.get('ask_user') ?? [];
        const cards = [...skillTexts().join('\n').matchAll(/^\s*ask_user\((\{[\s\S]*?\n\s*\})\)/gm)];

        expect(cards.length).toBeGreaterThanOrEqual(3);

        for (const [, literal] of cards) {
            // The examples are plain object literals, so JavaScript can read them.
            const result = schema.safeParse(new Function(`return (${ literal });`)());

            expect({ literal, ok: result.success }).toEqual({ literal, ok: true });
        }
    });
});
