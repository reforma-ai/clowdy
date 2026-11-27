import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getProject } from '../src/db/projects';
import { defaultSystemSkillsSource } from '../src/skills/materialize';
import { cleanTempDirs, command, Harness, restartHarness, startHarness, tempDir, waitFor } from './helpers';
import { writeSkill } from './skill-helpers';

import type { SkillCatalog } from '@clowdy/protocol';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
        await harness.stop();
    }
});

async function start(userRoots: string[] = []): Promise<Harness> {
    const harness = await startHarness({ userSkillRoots: userRoots });

    harnesses.push(harness);

    return harness;
}

async function catalogOf(h: Harness, projectId?: string): Promise<SkillCatalog> {
    const response = await h.fetch(projectId === undefined ? '/v1/skills' : `/v1/skills?projectId=${projectId}`);

    expect(response.status).toBe(200);

    return (await response.json()) as SkillCatalog;
}

const skillEvents = (h: Harness, after: number) =>
    h.events(after).filter(event => event.data.type === 'skills.changed');

describe('GET /v1/skills', () => {
    test('needs the bearer token', async () => {
        const h = await start();

        expect((await fetch(`${h.url}/v1/skills`)).status).toBe(401);
    });

    test('serves the system skills, named clowdy:<skill>, with their cost and without a path', async () => {
        const h = await start();
        const { entries, tokens, warnings } = await catalogOf(h);

        expect(entries.map(entry => entry.name)).toEqual(['orchestrate', 'thread'].map(name => `clowdy:${name}`));
        expect(
            entries.every(
                entry => entry.source === 'system' && entry.enabled && entry.tokens > 0 && entry.path === undefined
            )
        ).toBe(true);
        expect(entries[0].engines).toEqual(['claude', 'codex']);
        expect(tokens).toBe(entries.reduce((sum, entry) => sum + entry.tokens, 0));
        expect(warnings).toEqual([]);
    });

    test('adds the user skills, and with a project id also the project skills', async () => {
        const user = tempDir();
        const h = await start([user]);
        const project = h.openRepo();

        writeSkill(user, 'deploy', 'Ship it');
        writeSkill(join(project.path, '.claude', 'skills'), 'review', 'Review a change');
        writeSkill(join(project.path, '.agents', 'skills'), 'triage', 'Sort issues');

        const withoutProject = await catalogOf(h);
        const withProject = await catalogOf(h, project.id);

        expect(withoutProject.entries.filter(entry => entry.source !== 'system').map(entry => entry.name)).toEqual([
            'user:deploy',
        ]);
        expect(
            withProject.entries
                .filter(entry => entry.source !== 'system')
                .map(entry => [entry.name, entry.source, entry.engines, entry.description])
        ).toEqual([
            ['user:deploy', 'user', ['claude', 'codex'], 'Ship it'],
            ['review', 'project', ['claude'], 'Review a change'],
            ['triage', 'project', ['codex'], 'Sort issues'],
        ]);
        expect(withProject.entries.find(entry => entry.name === 'review')?.path).toBe(
            join(project.path, '.claude', 'skills', 'review')
        );
    });

    test('a project that does not exist is a 404', async () => {
        const h = await start();
        const response = await h.fetch('/v1/skills?projectId=prj_nope');

        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ ok: false, error: { code: 'not_found' } });
    });

    test('reports skills it had to skip', async () => {
        const user = tempDir();
        const h = await start([user]);

        writeSkill(user, 'good');
        writeSkill(user, 'bad', '', '---\nname: bad\n---\n');

        const { entries, warnings } = await catalogOf(h);

        expect(entries.some(entry => entry.name === 'user:good')).toBe(true);
        expect(warnings).toEqual([expect.stringContaining('Skipped "bad": it has no description')]);
    });

    test('a user skills folder that does not exist is fine', async () => {
        const h = await start([join(tempDir(), 'nope')]);

        expect((await catalogOf(h)).entries.every(entry => entry.source === 'system')).toBe(true);
    });
});

describe('what the engines are given', () => {
    test('the system skills plugin is copied to the data folder and named in the config', async () => {
        const h = await start();
        const dir = h.config.systemSkillsDir as string;

        expect(dir.startsWith(join(h.config.dataDir, 'system-skills'))).toBe(true);
        expect(JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('clowdy');
        expect(existsSync(join(dir, 'skills', 'orchestrate', 'SKILL.md'))).toBe(true);
    });

    test('a restart reuses the copy', async () => {
        const first = await start();
        const dir = first.config.systemSkillsDir;

        await first.stop();
        harnesses.length = 0;

        const second = await restartHarness(first);

        harnesses.push(second);

        expect(second.config.systemSkillsDir).toBe(dir as string);
        expect(readdirSync(join(first.config.dataDir, 'system-skills'))).toHaveLength(1);
    });
});

describe('skills.setEnabled', () => {
    test('system switches use the bundle from daemon startup when the source changes', async () => {
        const source = tempDir();
        cpSync(defaultSystemSkillsSource(), source, { recursive: true });
        const h = await startHarness({ userSkillRoots: [], systemSkillsSource: source });
        harnesses.push(h);
        writeFileSync(join(source, 'skills', 'thread', 'SKILL.md'), 'Unannotated clowdy:orchestrate');

        h.ok('skills.setEnabled', { name: 'clowdy:orchestrate', enabled: false });
        const thread = readFileSync(join(h.config.systemSkillsDir as string, 'skills', 'thread', 'SKILL.md'), 'utf8');
        expect(thread).toContain('Your parent reads only your reports');
        expect((await catalogOf(h)).entries.find(entry => entry.name === 'clowdy:orchestrate')?.enabled).toBe(false);
    });

    test('a failed system skill rebuild leaves the previous selection in place', async () => {
        const source = tempDir();
        cpSync(defaultSystemSkillsSource(), source, { recursive: true });
        const h = await startHarness({ userSkillRoots: [], systemSkillsSource: source });
        harnesses.push(h);
        const previous = h.config.systemSkillsDir;
        rmSync(join(h.config.dataDir, 'system-skills-source'), { recursive: true });

        expect(h.send('skills.setEnabled', { name: 'clowdy:orchestrate', enabled: false })).toMatchObject({
            ok: false,
        });
        expect(h.config.systemSkillsDir).toBe(previous);
        expect((await catalogOf(h)).entries.find(entry => entry.name === 'clowdy:orchestrate')?.enabled).toBe(true);
    });

    test('system choices persist, control delivery and do not change user skills', async () => {
        const user = tempDir();
        writeSkill(user, 'orchestrate');
        const first = await start([user]);
        const original = first.config.systemSkillsDir as string;
        first.ok('skills.setEnabled', { name: 'clowdy:orchestrate', enabled: false });
        const filtered = first.config.systemSkillsDir as string;
        expect(existsSync(join(filtered, 'skills', 'orchestrate'))).toBe(false);
        const thread = readFileSync(join(filtered, 'skills', 'thread', 'SKILL.md'), 'utf8');
        expect(thread).not.toContain('clowdy:orchestrate');
        expect(thread).toContain('Your parent reads only your reports');
        expect(existsSync(join(original, 'skills', 'orchestrate', 'SKILL.md'))).toBe(true);
        expect(
            (await catalogOf(first)).entries
                .filter(entry => entry.source === 'user')
                .map(entry => [entry.name, entry.enabled])
        ).toEqual([['user:orchestrate', true]]);
        first.ok('skills.setEnabled', { name: 'clowdy:*', enabled: false });
        expect(readdirSync(join(first.config.systemSkillsDir as string, 'skills'))).toEqual([]);
        await first.stop();
        harnesses.length = 0;
        const second = await restartHarness(first);
        harnesses.push(second);
        const catalog = await catalogOf(second);
        expect(catalog.systemEnabled).toBe(false);
        expect(catalog.entries.find(entry => entry.name === 'clowdy:orchestrate')?.enabled).toBe(false);
        expect(readdirSync(join(second.config.systemSkillsDir as string, 'skills'))).toEqual([]);
        second.ok('skills.setEnabled', { name: 'clowdy:*', enabled: true });
        expect(existsSync(join(second.config.systemSkillsDir as string, 'skills', 'orchestrate'))).toBe(false);
        second.ok('skills.setEnabled', { name: 'clowdy:orchestrate', enabled: true });
        expect(second.config.systemSkillsDir).toBe(original);
    });

    test('switches a user skill off and on, keeps it in skills.json, and the catalog follows', async () => {
        const user = tempDir();

        writeSkill(user, 'deploy');
        writeSkill(user, 'lint');

        const h = await start([user]);

        expect(h.ok('skills.setEnabled', { name: 'user:deploy', enabled: false })).toEqual({
            name: 'user:deploy',
            enabled: false,
        });
        expect(JSON.parse(readFileSync(join(h.config.dataDir, 'skills.json'), 'utf8'))).toEqual({
            disabled: ['deploy'],
        });
        expect(
            (await catalogOf(h)).entries
                .filter(entry => entry.source === 'user')
                .map(entry => [entry.name, entry.enabled])
        ).toEqual([
            ['user:deploy', false],
            ['user:lint', true],
        ]);

        h.ok('skills.setEnabled', { name: 'user:deploy', enabled: true });

        expect((await catalogOf(h)).entries.find(entry => entry.name === 'user:deploy')?.enabled).toBe(true);
    });

    test('a user skill switched off stays off after a restart', async () => {
        const user = tempDir();

        writeSkill(user, 'deploy');

        const first = await start([user]);

        first.ok('skills.setEnabled', { name: 'user:deploy', enabled: false });

        await first.stop();
        harnesses.length = 0;

        const second = await restartHarness(first);

        harnesses.push(second);

        expect((await catalogOf(second)).entries.find(entry => entry.name === 'user:deploy')?.enabled).toBe(false);
    });

    test('a skill added later starts on, and a switched-off skill that goes and returns is still off', async () => {
        const user = tempDir();

        writeSkill(user, 'deploy');

        const h = await start([user]);

        h.ok('skills.setEnabled', { name: 'user:deploy', enabled: false });
        rmSync(join(user, 'deploy'), { recursive: true });
        writeSkill(user, 'fresh');
        writeSkill(user, 'deploy');

        expect(
            (await catalogOf(h)).entries
                .filter(entry => entry.source === 'user')
                .map(entry => [entry.name, entry.enabled])
        ).toEqual([
            ['user:deploy', false],
            ['user:fresh', true],
        ]);
    });

    test('refuses unknown and project skills, with a reason', async () => {
        const user = tempDir();
        const h = await start([user]);
        const project = h.openRepo();

        writeSkill(user, 'deploy');
        writeSkill(join(project.path, '.claude', 'skills'), 'review');

        expect(h.send('skills.setEnabled', { name: 'clowdy:nope', enabled: false })).toMatchObject({
            ok: false,
            error: { code: 'not_found' },
        });
        expect(h.send('skills.setEnabled', { name: 'review', enabled: false })).toMatchObject({
            ok: false,
            error: { code: 'invalid' },
        });
        expect(h.send('skills.setEnabled', { name: 'deploy', enabled: false })).toMatchObject({
            ok: false,
            error: { code: 'invalid' },
        });
        expect(h.send('skills.setEnabled', { name: 'user:nope', enabled: false })).toMatchObject({
            ok: false,
            error: { code: 'not_found' },
        });
        expect(existsSync(join(h.config.dataDir, 'skills.json'))).toBe(false);
    });

    test('rejects a malformed command over HTTP', async () => {
        const h = await start();

        for (const body of [
            { name: 'user:x' },
            { enabled: true },
            { name: '', enabled: true },
            { name: 'user:x', enabled: 'yes' },
        ]) {
            const response = await h.fetch('/v1/commands', {
                method: 'POST',
                body: JSON.stringify(command('skills.setEnabled', body)),
            });

            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({
                ok: false,
                error: { code: 'invalid', message: 'The command is not valid' },
            });
        }
    });

    test('is idempotent by requestId and announces once per project, and nothing when the state is the same', async () => {
        const user = tempDir();

        writeSkill(user, 'deploy');

        const h = await start([user]);
        const first = h.openRepo('one');
        const second = h.openRepo('two');
        const before = h.store.headCursor();
        const toggle = command('skills.setEnabled', { name: 'user:deploy', enabled: false });

        const sent = await h.fetch('/v1/commands', { method: 'POST', body: JSON.stringify(toggle) });
        const again = await h.fetch('/v1/commands', { method: 'POST', body: JSON.stringify(toggle) });

        expect(await again.json()).toEqual(await sent.json());
        expect(
            skillEvents(h, before)
                .map(event => event.projectId)
                .sort()
        ).toEqual([h.personal.id, first.id, second.id].sort());

        h.ok('skills.setEnabled', { name: 'user:deploy', enabled: false });

        expect(skillEvents(h, before)).toHaveLength(3);
    });
});

describe('watching the skill folders', () => {
    test('a user skill that appears or is edited is announced once to every project, and the catalog follows', async () => {
        const user = tempDir();
        const h = await start([user]);
        const first = h.openRepo('one');
        const second = h.openRepo('two');
        const before = h.store.headCursor();

        writeSkill(user, 'deploy', 'First version');

        const events = await waitFor(
            () => skillEvents(h, before).length >= 3 && skillEvents(h, before),
            'skills.changed for every project'
        );

        expect(events.map(event => event.projectId).sort()).toEqual([h.personal.id, first.id, second.id].sort());
        expect((await catalogOf(h)).entries.find(entry => entry.name === 'user:deploy')?.description).toBe(
            'First version'
        );

        const afterAdd = h.store.headCursor();

        writeSkill(user, 'deploy', 'Second version, a little longer');
        await waitFor(() => skillEvents(h, afterAdd).length >= 3, 'skills.changed after an edit');

        expect((await catalogOf(h)).entries.find(entry => entry.name === 'user:deploy')?.description).toBe(
            'Second version, a little longer'
        );
    });

    test('skills in a folder that did not exist at start are announced once when the catalog next shows them', async () => {
        const root = join(tempDir(), 'later');
        const h = await start([root]);

        h.openRepo();

        const before = h.store.headCursor();

        writeSkill(root, 'deploy');

        const catalog = await catalogOf(h);

        // Announced once to each project: the personal space and the one opened here.
        expect(catalog.entries.find(entry => entry.name === 'user:deploy')?.enabled).toBe(true);
        expect(skillEvents(h, before)).toHaveLength(2);

        await catalogOf(h);

        expect(skillEvents(h, before)).toHaveLength(2);
    });

    test('a burst of writes is one announcement', async () => {
        const user = tempDir();
        const h = await start([user]);

        h.openRepo();

        const before = h.store.headCursor();

        for (let index = 0; index < 5; index++) {
            writeSkill(user, `skill-${index}`);
        }

        await waitFor(() => skillEvents(h, before).length > 0, 'skills.changed');
        await Bun.sleep(500);

        // One announcement per project: the personal space and the one opened here.
        expect(skillEvents(h, before)).toHaveLength(2);
    });

    test('a project skill is announced to that project only', async () => {
        const h = await start();
        const watched = h.openRepo('watched');
        const other = h.openRepo('other');

        mkdirSync(join(watched.path, '.claude', 'skills'), { recursive: true });
        await h.fetch(`/v1/skills?projectId=${watched.id}`);

        const before = h.store.headCursor();

        writeSkill(join(watched.path, '.claude', 'skills'), 'review');

        const events = await waitFor(
            () => skillEvents(h, before).length > 0 && skillEvents(h, before),
            'skills.changed'
        );

        expect(events.map(event => event.projectId)).toEqual([watched.id]);
        expect(skillEvents(h, before).some(event => event.projectId === other.id)).toBe(false);
        expect((await catalogOf(h, watched.id)).entries.some(entry => entry.name === 'review')).toBe(true);
    });

    test('with several folders the skills of each are listed, the folder name in front of their folder', async () => {
        const h = await start();
        const web = h.openRepo('web');
        const api = h.openRepo('api');
        const main = h.store.read(() => getProject(h.store.db, web.id))?.folders[0].id;

        h.ok('project.update', { projectId: web.id, folders: [{ id: main }, { path: api.path }] });
        writeSkill(join(web.path, '.claude', 'skills'), 'review');
        writeSkill(join(api.path, '.agents', 'skills'), 'triage');

        const entries = (await catalogOf(h, web.id)).entries.filter(entry => entry.source === 'project');

        expect(entries.map(entry => [entry.id, entry.engines])).toEqual([
            ['project:web/.claude/skills/review', ['claude']],
            ['project:api/.agents/skills/triage', ['codex']],
        ]);
        expect(entries[1].path).toBe(join(api.path, '.agents', 'skills', 'triage'));
    });

    test('a project told other folders is told to read its catalog again, which then follows the folders', async () => {
        const h = await start();
        const web = h.openRepo('web');
        const api = h.openRepo('api');
        const main = h.store.read(() => getProject(h.store.db, web.id))?.folders[0].id;
        const projectSkills = async () =>
            (await catalogOf(h, web.id)).entries.filter(entry => entry.source === 'project').map(entry => entry.name);

        writeSkill(join(api.path, '.agents', 'skills'), 'triage');
        expect(await projectSkills()).toEqual([]);

        const before = h.store.headCursor();

        h.ok('project.update', { projectId: web.id, folders: [{ id: main }, { path: api.path }] });
        expect(skillEvents(h, before).map(event => event.projectId)).toEqual([web.id]);
        expect(await projectSkills()).toEqual(['triage']);

        // A rename or the same list leaves the catalog as it was, and says nothing.
        const unchanged = h.store.headCursor();

        h.ok('project.update', { projectId: web.id, name: 'Web', folders: [{ id: main }, { path: api.path }] });
        expect(skillEvents(h, unchanged)).toEqual([]);

        h.ok('project.update', { projectId: web.id, folders: [{ id: main }] });
        expect(skillEvents(h, unchanged).map(event => event.projectId)).toEqual([web.id]);
        expect(await projectSkills()).toEqual([]);
    });

    test('a project skill in a folder two projects share is announced to both', async () => {
        const h = await start();
        const shared = h.openRepo('shared');
        const other = h.openRepo('other');
        const both = h.ok('project.add', { folders: [other.path, shared.path] }).project as { id: string };

        mkdirSync(join(shared.path, '.claude', 'skills'), { recursive: true });
        await h.fetch(`/v1/skills?projectId=${shared.id}`);
        await h.fetch(`/v1/skills?projectId=${both.id}`);

        const before = h.store.headCursor();

        writeSkill(join(shared.path, '.claude', 'skills'), 'review');

        const events = await waitFor(
            () => skillEvents(h, before).length >= 2 && skillEvents(h, before),
            'skills.changed for both projects'
        );

        expect(events.map(event => event.projectId).sort()).toEqual([shared.id, both.id].sort());
        expect(skillEvents(h, before).some(event => event.projectId === other.id)).toBe(false);
    });

    test('touching a file without changing the skills announces nothing', async () => {
        const user = tempDir();

        writeSkill(user, 'deploy');

        const h = await start([user]);

        h.openRepo();
        writeFileSync(join(user, 'notes.txt'), 'not a skill');
        await Bun.sleep(700);

        expect(skillEvents(h, 0)).toHaveLength(0);
    });
});
