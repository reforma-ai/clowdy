import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
    const response = await h.fetch(projectId === undefined ? '/v1/skills' : `/v1/skills?projectId=${ projectId }`);

    expect(response.status).toBe(200);

    return await response.json() as SkillCatalog;
}

const skillEvents = (h: Harness, after: number) => h.events(after).filter(event => event.data.type === 'skills.changed');

describe('GET /v1/skills', () => {
    test('needs the bearer token', async () => {
        const h = await start();

        expect((await fetch(`${ h.url }/v1/skills`)).status).toBe(401);
    });

    test('serves the system skills, named clowdy:<skill>, with their cost and without a path', async () => {
        const h = await start();
        const { entries, tokens, warnings } = await catalogOf(h);

        expect(entries.map(entry => entry.name)).toEqual(['autopilot', 'docs', 'executor', 'orchestrate', 'scaffold', 'semi-manual', 'verify'].map(name => `clowdy:${ name }`));
        expect(entries.every(entry => entry.source === 'system' && entry.enabled && entry.tokens > 0 && entry.path === undefined)).toBe(true);
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

        expect(withoutProject.entries.filter(entry => entry.source !== 'system').map(entry => entry.name)).toEqual(['user:deploy']);
        expect(withProject.entries.filter(entry => entry.source !== 'system').map(entry => [entry.name, entry.source, entry.engines, entry.description])).toEqual([
            ['user:deploy', 'user', ['claude', 'codex'], 'Ship it'],
            ['review', 'project', ['claude'], 'Review a change'],
            ['triage', 'project', ['codex'], 'Sort issues'],
        ]);
        expect(withProject.entries.find(entry => entry.name === 'review')?.path).toBe(join(project.path, '.claude', 'skills', 'review'));
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
    test('skills in a folder that did not exist at start reach the engines when the catalog next shows them', async () => {
        const root = join(tempDir(), 'later');
        const h = await start([root]);

        h.openRepo();

        const before = h.store.headCursor();

        writeSkill(root, 'deploy');

        const catalog = await catalogOf(h);

        // Announced once to each project: the personal space and the one opened here.
        expect(catalog.entries.find(entry => entry.name === 'user:deploy')?.enabled).toBe(true);
        expect(readdirSync(join((h.config.extraPluginDirs as string[])[0], 'skills'))).toEqual(['deploy']);
        expect(skillEvents(h, before)).toHaveLength(2);

        await catalogOf(h);

        expect(skillEvents(h, before)).toHaveLength(2);
    });

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

    test('the enabled user skills are carried by one plugin folder in extraPluginDirs, none when there are none', async () => {
        const user = tempDir();
        const none = await start();
        const h = await start([user]);

        expect(none.config.extraPluginDirs).toEqual([]);
        expect(h.config.extraPluginDirs).toEqual([]);

        writeSkill(user, 'deploy');
        await h.fetch('/v1/skills');
        await waitFor(() => h.config.extraPluginDirs?.length, 'the user plugin');

        const [dir] = h.config.extraPluginDirs as string[];

        expect(dir.startsWith(join(h.config.dataDir, 'user-skills-plugin'))).toBe(true);
        expect(readdirSync(join(dir, 'skills'))).toEqual(['deploy']);
    });

    test('user skills that exist at start are in the plugin at once', async () => {
        const user = tempDir();

        writeSkill(user, 'deploy');
        writeSkill(user, 'lint');

        const h = await start([user]);

        expect(readdirSync(join((h.config.extraPluginDirs as string[])[0], 'skills')).sort()).toEqual(['deploy', 'lint']);
    });
});

describe('skills.setEnabled', () => {
    test('switches a user skill off and on, keeps it in skills.json, and rebuilds the plugin', async () => {
        const user = tempDir();

        writeSkill(user, 'deploy');
        writeSkill(user, 'lint');

        const h = await start([user]);
        const carried = () => readdirSync(join((h.config.extraPluginDirs as string[])[0], 'skills')).sort();

        expect(h.ok('skills.setEnabled', { name: 'user:deploy', enabled: false })).toEqual({ name: 'user:deploy', enabled: false });
        expect(JSON.parse(readFileSync(join(h.config.dataDir, 'skills.json'), 'utf8'))).toEqual({ disabled: ['deploy'] });
        expect(carried()).toEqual(['lint']);
        expect((await catalogOf(h)).entries.filter(entry => entry.source === 'user').map(entry => [entry.name, entry.enabled])).toEqual([['user:deploy', false], ['user:lint', true]]);

        h.ok('skills.setEnabled', { name: 'user:deploy', enabled: true });

        expect(carried()).toEqual(['deploy', 'lint']);
        expect((await catalogOf(h)).entries.find(entry => entry.name === 'user:deploy')?.enabled).toBe(true);
    });

    test('switching off every skill leaves no plugin, and the choice survives a restart', async () => {
        const user = tempDir();

        writeSkill(user, 'deploy');

        const first = await start([user]);

        first.ok('skills.setEnabled', { name: 'user:deploy', enabled: false });
        expect(first.config.extraPluginDirs).toEqual([]);

        await first.stop();
        harnesses.length = 0;

        const second = await restartHarness(first);

        harnesses.push(second);

        expect(second.config.extraPluginDirs).toEqual([]);
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

        expect((await catalogOf(h)).entries.filter(entry => entry.source === 'user').map(entry => [entry.name, entry.enabled])).toEqual([['user:deploy', false], ['user:fresh', true]]);
    });

    test('refuses what is not a user skill, with a reason', async () => {
        const user = tempDir();
        const h = await start([user]);
        const project = h.openRepo();

        writeSkill(user, 'deploy');
        writeSkill(join(project.path, '.claude', 'skills'), 'review');

        expect(h.send('skills.setEnabled', { name: 'clowdy:docs', enabled: false })).toMatchObject({ ok: false, error: { code: 'invalid', message: 'System skills cannot be switched off' } });
        expect(h.send('skills.setEnabled', { name: 'review', enabled: false })).toMatchObject({ ok: false, error: { code: 'invalid' } });
        expect(h.send('skills.setEnabled', { name: 'deploy', enabled: false })).toMatchObject({ ok: false, error: { code: 'invalid' } });
        expect(h.send('skills.setEnabled', { name: 'user:nope', enabled: false })).toMatchObject({ ok: false, error: { code: 'not_found' } });
        expect(existsSync(join(h.config.dataDir, 'skills.json'))).toBe(false);
    });

    test('rejects a malformed command over HTTP', async () => {
        const h = await start();

        for (const body of [{ name: 'user:x' }, { enabled: true }, { name: '', enabled: true }, { name: 'user:x', enabled: 'yes' }]) {
            const response = await h.fetch('/v1/commands', { method: 'POST', body: JSON.stringify(command('skills.setEnabled', body)) });

            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid', message: 'The command is not valid' } });
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
        expect(skillEvents(h, before).map(event => event.projectId).sort()).toEqual([h.personal.id, first.id, second.id].sort());

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

        const events = await waitFor(() => skillEvents(h, before).length >= 3 && skillEvents(h, before), 'skills.changed for every project');

        expect(events.map(event => event.projectId).sort()).toEqual([h.personal.id, first.id, second.id].sort());
        expect((await catalogOf(h)).entries.find(entry => entry.name === 'user:deploy')?.description).toBe('First version');
        expect(readdirSync(join((h.config.extraPluginDirs as string[])[0], 'skills'))).toEqual(['deploy']);

        const afterAdd = h.store.headCursor();

        writeSkill(user, 'deploy', 'Second version, a little longer');
        await waitFor(() => skillEvents(h, afterAdd).length >= 3, 'skills.changed after an edit');

        expect((await catalogOf(h)).entries.find(entry => entry.name === 'user:deploy')?.description).toBe('Second version, a little longer');
    });

    test('a burst of writes is one announcement', async () => {
        const user = tempDir();
        const h = await start([user]);

        h.openRepo();

        const before = h.store.headCursor();

        for (let index = 0; index < 5; index++) {
            writeSkill(user, `skill-${ index }`);
        }

        await waitFor(() => skillEvents(h, before).length > 0, 'skills.changed');
        await Bun.sleep(500);

        // One announcement per project: the personal space and the one opened here.
        expect(skillEvents(h, before)).toHaveLength(2);
        expect(readdirSync(join((h.config.extraPluginDirs as string[])[0], 'skills'))).toHaveLength(5);
    });

    test('a project skill is announced to that project only', async () => {
        const h = await start();
        const watched = h.openRepo('watched');
        const other = h.openRepo('other');

        mkdirSync(join(watched.path, '.claude', 'skills'), { recursive: true });
        await h.fetch(`/v1/skills?projectId=${ watched.id }`);

        const before = h.store.headCursor();

        writeSkill(join(watched.path, '.claude', 'skills'), 'review');

        const events = await waitFor(() => skillEvents(h, before).length > 0 && skillEvents(h, before), 'skills.changed');

        expect(events.map(event => event.projectId)).toEqual([watched.id]);
        expect(skillEvents(h, before).some(event => event.projectId === other.id)).toBe(false);
        expect((await catalogOf(h, watched.id)).entries.some(entry => entry.name === 'review')).toBe(true);
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
