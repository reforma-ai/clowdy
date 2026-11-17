import { afterAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getProject } from '../src/db/projects';
import { toolsFor } from '../src/runs/tools';
import { defaultSystemSkillsSource } from '../src/skills/materialize';
import { cleanTempDirs, startHarness } from './helpers';

import type { ZodType } from 'zod';

afterAll(cleanTempDirs);

/** Every Markdown file of the system skills, with its text. */
function skillTexts(dir = join(defaultSystemSkillsSource(), 'skills')): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => (
        entry.isDirectory() ? skillTexts(join(dir, entry.name)) : entry.name.endsWith('.md') ? [readFileSync(join(dir, entry.name), 'utf8')] : []
    ));
}

/** The tools of every role and mode, by name; where roles differ (`task_update`) their fields are one set. */
async function daemonTools() {
    const h = await startHarness();

    try {
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { store, runs, driver } = h.daemon.services;
        const orchestrator = runs.createRun({ project: getProject(store.db, project.id)!, role: 'orchestrator', chatId: chat.id, summary: 'Plan' });
        const executor = runs.createRun({ project: getProject(store.db, project.id)!, role: 'executor', summary: 'Work', parent: orchestrator, origin: 'spawned' });
        const fields = new Map<string, Set<string>>();
        const schemas = new Map<string, ZodType[]>();

        for (const run of [orchestrator, executor]) {
            for (const tool of toolsFor({ store, runs, driver }, run, runs.modeOf(run))) {
                const properties = Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>);

                fields.set(tool.name, new Set([...fields.get(tool.name) ?? [], ...properties]));
                schemas.set(tool.name, [...schemas.get(tool.name) ?? [], tool.schema]);
            }
        }

        return { fields, schemas };
    }
    finally {
        await h.stop();
    }
}

describe('the system skills and the tools the daemon gives agents', () => {
    test('name the same tools: every tool is taught somewhere and nothing else is called a tool', async () => {
        const { fields } = await daemonTools();
        const mentioned = new Set(skillTexts().join('\n').match(/\b(?:task|run|ask|report)_[a-z]+\b/g));

        expect([...mentioned].sort()).toEqual([...fields.keys()].sort());
    });

    test('use only fields a tool has when they write a call as `tool({ field, field })`', async () => {
        const { fields } = await daemonTools();
        const calls = [...skillTexts().join('\n').matchAll(/\b([a-z]+_[a-z]+)\(\{([^}\n]*)\}\)/g)];

        expect(calls.length).toBeGreaterThan(5);

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
