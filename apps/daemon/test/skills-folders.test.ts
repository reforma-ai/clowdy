import { afterAll, describe, expect, test } from 'bun:test';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { buildCatalog, estimateTokens, mergeUserSkills } from '../src/skills/catalog';
import { defaultSystemSkillsSource, materializeSystemSkills } from '../src/skills/materialize';
import { buildUserMirror } from '../src/skills/mirror';
import { SkillScanner } from '../src/skills/scan';
import { SkillSettings } from '../src/skills/settings';
import { cleanTempDirs, tempDir } from './helpers';
import { writeSkill } from './skill-helpers';

import type { LabeledScan, ProjectScan } from '../src/skills/catalog';

afterAll(cleanTempDirs);

const scanner = new SkillScanner();
const labeled = (label: string, root: string): LabeledScan => ({ label, scan: scanner.scan(root) });
const names = (catalog: { entries: { name: string }[] }) => catalog.entries.map(entry => entry.name);

describe('the catalog', () => {
    const empty = { skills: [], fingerprint: '', warnings: [] };

    test('names skills the way the engines do: clowdy: for system, user: for user, plain for project', () => {
        const system = tempDir();
        const user = tempDir();
        const project = tempDir();

        writeSkill(system, 'orchestrate');
        writeSkill(user, 'deploy');
        writeSkill(project, 'ship');

        const catalog = buildCatalog({
            system: scanner.scan(system),
            user: mergeUserSkills([labeled('~/.claude/skills', user)]),
            project: [{ ...labeled('.claude/skills', project), engine: 'claude' }],
            disabled: new Set(),
        });

        expect(
            catalog.entries.map(({ id, name, source, enabled, engines }) => ({ id, name, source, enabled, engines }))
        ).toEqual([
            {
                id: 'system:orchestrate',
                name: 'clowdy:orchestrate',
                source: 'system',
                enabled: true,
                engines: ['claude', 'codex'],
            },
            { id: 'user:deploy', name: 'user:deploy', source: 'user', enabled: true, engines: ['claude', 'codex'] },
            { id: 'project:.claude/skills/ship', name: 'ship', source: 'project', enabled: true, engines: ['claude'] },
        ]);
        expect(catalog.entries[0]).not.toHaveProperty('path');
        expect(catalog.entries[1].path).toBe(join(user, 'deploy'));
        expect(catalog.entries[2].path).toBe(join(project, 'ship'));
    });

    test('a user skill in a later folder hides the same name in an earlier one, and says so', () => {
        const claude = tempDir();
        const agents = tempDir();

        writeSkill(claude, 'shared', 'From .claude');
        writeSkill(claude, 'only-claude');
        writeSkill(agents, 'shared', 'From .agents');

        const { skills, warnings } = mergeUserSkills([
            labeled('~/.claude/skills', claude),
            labeled('~/.agents/skills', agents),
        ]);

        expect(skills.map(skill => [skill.folder, skill.description])).toEqual([
            ['only-claude', 'Does only-claude work'],
            ['shared', 'From .agents'],
        ]);
        expect(warnings).toEqual(['"shared" in ~/.claude/skills is hidden by the one in ~/.agents/skills']);
    });

    test('the same folder reached through two roots is not a clash', () => {
        const claude = tempDir();
        const agents = tempDir();

        symlinkSync(writeSkill(tempDir(), 'shared'), join(agents, 'shared'), 'dir');
        symlinkSync(join(agents, 'shared'), join(claude, 'shared'), 'dir');

        expect(mergeUserSkills([labeled('a', claude), labeled('b', agents)]).warnings).toEqual([]);
    });

    test('project skills belong to the engine that reads their folder, and one folder reached twice is one skill', () => {
        const claude = tempDir();
        const agents = tempDir();

        writeSkill(claude, 'for-claude');
        writeSkill(agents, 'for-codex');
        symlinkSync(writeSkill(tempDir(), 'both'), join(claude, 'both'), 'dir');
        symlinkSync(join(claude, 'both'), join(agents, 'both'), 'dir');

        const project: ProjectScan[] = [
            { ...labeled('.claude/skills', claude), engine: 'claude' },
            { ...labeled('.agents/skills', agents), engine: 'codex' },
        ];

        const { entries } = buildCatalog({
            system: empty,
            user: { skills: [], warnings: [] },
            project,
            disabled: new Set(),
        });

        expect(entries.map(entry => [entry.name, entry.engines])).toEqual([
            ['both', ['claude', 'codex']],
            ['for-claude', ['claude']],
            ['for-codex', ['codex']],
        ]);
    });

    test('a skill switched off keeps its cost but stops counting', () => {
        const user = tempDir();

        writeSkill(user, 'on');
        writeSkill(user, 'off');

        const merged = mergeUserSkills([labeled('u', user)]);
        const all = buildCatalog({ system: empty, user: merged, project: [], disabled: new Set() });
        const some = buildCatalog({ system: empty, user: merged, project: [], disabled: new Set(['off']) });

        expect(some.entries.map(entry => [entry.name, entry.enabled])).toEqual([
            ['user:off', false],
            ['user:on', true],
        ]);
        expect(some.entries[0].tokens).toBe(all.entries[0].tokens);
        expect(some.entries[0].tokens).toBeGreaterThan(0);
        expect(some.tokens).toBe(some.entries[1].tokens);
        expect(all.tokens).toBe(all.entries[0].tokens + all.entries[1].tokens);
    });

    test('estimates a short skill between 33 and 48 tokens, as measured', () => {
        const tokens = estimateTokens(
            'user:deploy',
            'Build the app, run every check and push it to the staging server when asked to ship.'
        );

        expect(tokens).toBeGreaterThanOrEqual(33);
        expect(tokens).toBeLessThanOrEqual(48);
        expect(estimateTokens('a', 'b'.repeat(400))).toBeGreaterThan(estimateTokens('a', 'b'.repeat(40)));
    });

    test('warns when the enabled skills cost a lot, and reports what every folder said', () => {
        const user = tempDir();

        for (let index = 0; index < 30; index++) {
            writeSkill(user, `skill-${index}`, 'x'.repeat(300));
        }

        writeSkill(user, 'broken', '', '---\nname: broken\n---\n');

        const merged = mergeUserSkills([labeled('~/.claude/skills', user)]);
        const heavy = buildCatalog({
            system: empty,
            user: merged,
            project: [],
            disabled: new Set(),
            warnings: ['skills.json is damaged'],
        });
        const light = buildCatalog({
            system: empty,
            user: merged,
            project: [],
            disabled: new Set(merged.skills.map(skill => skill.folder)),
        });

        expect(heavy.tokens).toBeGreaterThan(2000);
        expect(heavy.warnings).toEqual([
            'skills.json is damaged',
            '~/.claude/skills: Skipped "broken": it has no description',
            expect.stringMatching(/^The enabled skills cost about \d+ tokens in every run/),
        ]);
        expect(light.tokens).toBe(0);
        expect(light.warnings).toEqual(['~/.claude/skills: Skipped "broken": it has no description']);
    });

    test('lists system, user and project skills in that order, each group by name', () => {
        const system = tempDir();
        const user = tempDir();
        const project = tempDir();

        ['scaffold', 'docs'].forEach(folder => writeSkill(system, folder));
        ['b', 'a'].forEach(folder => writeSkill(user, folder));
        ['z', 'y'].forEach(folder => writeSkill(project, folder));

        const catalog = buildCatalog({
            system: scanner.scan(system),
            user: mergeUserSkills([labeled('u', user)]),
            project: [{ ...labeled('.claude/skills', project), engine: 'claude' }],
            disabled: new Set(),
        });

        expect(names(catalog)).toEqual(['clowdy:docs', 'clowdy:scaffold', 'user:a', 'user:b', 'y', 'z']);
    });
});

describe('which user skills are on', () => {
    test('everything is on until a skill is switched off, and a new skill starts on', () => {
        const settings = new SkillSettings(tempDir());

        expect(settings.read().disabled.size).toBe(0);
        expect(settings.setEnabled('deploy', false)).toBe(true);
        expect([...settings.read().disabled]).toEqual(['deploy']);
        expect(settings.read().disabled.has('brand-new')).toBe(false);
    });

    test('is a deny list in skills.json, sorted and without duplicates', () => {
        const dir = tempDir();
        const settings = new SkillSettings(dir);

        settings.setEnabled('b', false);
        settings.setEnabled('a', false);
        settings.setEnabled('b', false);

        expect(JSON.parse(readFileSync(join(dir, 'skills.json'), 'utf8'))).toEqual({ disabled: ['a', 'b'] });

        settings.setEnabled('a', true);

        expect(JSON.parse(readFileSync(join(dir, 'skills.json'), 'utf8'))).toEqual({ disabled: ['b'] });
    });

    test('says whether a change changed anything', () => {
        const settings = new SkillSettings(tempDir());

        expect(settings.setEnabled('a', true)).toBe(false);
        expect(settings.setEnabled('a', false)).toBe(true);
        expect(settings.setEnabled('a', false)).toBe(false);
        expect(settings.setEnabled('a', true)).toBe(true);
    });

    test('a damaged file leaves every skill on and warns, and the next change repairs it', () => {
        const dir = tempDir();
        const settings = new SkillSettings(dir);

        for (const damaged of ['{ not json', '{"disabled":"deploy"}', '[]']) {
            writeFileSync(join(dir, 'skills.json'), damaged);

            expect(settings.read()).toEqual({ disabled: new Set(), warning: expect.stringContaining('skills.json') });
        }

        settings.setEnabled('a', false);

        expect(settings.read()).toEqual({ disabled: new Set(['a']) });
    });
});

describe('the user plugin', () => {
    const skillsOf = (dir: string) => readdirSync(join(dir, 'skills')).sort();

    test('is a plugin named user with a link to each enabled skill', () => {
        const dataDir = tempDir();
        const user = tempDir();

        ['deploy', 'lint'].forEach(folder => writeSkill(user, folder));

        const dir = buildUserMirror(dataDir, mergeUserSkills([labeled('u', user)]).skills) as string;

        expect(dir.startsWith(join(dataDir, 'user-skills-plugin'))).toBe(true);
        expect(JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('user');
        expect(skillsOf(dir)).toEqual(['deploy', 'lint']);
        expect(lstatSync(join(dir, 'skills', 'deploy')).isSymbolicLink()).toBe(true);
        expect(realpathSync(join(dir, 'skills', 'deploy'))).toBe(realpathSync(join(user, 'deploy')));
        expect(readFileSync(join(dir, 'skills', 'lint', 'SKILL.md'), 'utf8')).toContain('description');
    });

    test('has no folder when there is no skill to carry', () => {
        const dataDir = tempDir();

        expect(buildUserMirror(dataDir, [])).toBeUndefined();
        expect(existsSync(join(dataDir, 'user-skills-plugin'))).toBe(false);
    });

    test('is reused for the same skills and new for a change, and old ones are pruned', () => {
        const dataDir = tempDir();
        const user = tempDir();
        const mirrors: string[] = [];

        for (const folder of ['s1', 's2', 's3', 's4', 's5', 's6', 's7']) {
            writeSkill(user, folder);

            const skills = mergeUserSkills([{ label: 'u', scan: new SkillScanner().scan(user) }]).skills;
            const dir = buildUserMirror(dataDir, skills) as string;

            expect(buildUserMirror(dataDir, skills)).toBe(dir);

            // Folders made in the same millisecond must still have an order.
            utimesSync(dir, new Date(1_000_000 + mirrors.length * 1000), new Date(1_000_000 + mirrors.length * 1000));
            mirrors.push(dir);
        }

        expect(new Set(mirrors).size).toBe(7);
        expect(readdirSync(join(dataDir, 'user-skills-plugin')).sort()).toEqual(
            mirrors
                .slice(2)
                .map(dir => dir.split('/').at(-1) as string)
                .sort()
        );
    });

    test('a skill that was edited gets a new plugin folder, so a link to old content is never reused', () => {
        const dataDir = tempDir();
        const user = tempDir();
        const dir = writeSkill(user, 'deploy', 'Before');
        const before = buildUserMirror(dataDir, mergeUserSkills([labeled('u', user)]).skills);

        writeSkill(user, 'deploy', 'A longer description than before');
        utimesSync(join(dir, 'SKILL.md'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));

        expect(
            buildUserMirror(dataDir, mergeUserSkills([{ label: 'u', scan: new SkillScanner().scan(user) }]).skills)
        ).not.toBe(before);
    });
});

describe('materializing the system skills', () => {
    function source(version = 'one', manifestName = 'clowdy'): string {
        const dir = tempDir('plugin');

        mkdirSync(join(dir, '.claude-plugin'));
        writeFileSync(
            join(dir, '.claude-plugin', 'plugin.json'),
            JSON.stringify({ name: manifestName, version: '0.1.0' })
        );
        writeSkill(join(dir, 'skills'), 'orchestrate', `Entry skill, version ${version}`);
        mkdirSync(join(dir, 'skills', 'orchestrate', 'references'));
        writeFileSync(join(dir, 'skills', 'orchestrate', 'references', 'fan-out.md'), `Fan out, ${version}`);
        writeFileSync(join(dir, 'README.md'), 'not part of the plugin');
        writeFileSync(join(dir, 'package.json'), '{}');
        mkdirSync(join(dir, 'scripts'));
        writeFileSync(join(dir, 'scripts', 'validate.ts'), '');
        writeFileSync(join(dir, 'skills', '.DS_Store'), 'junk');

        return dir;
    }

    const filesOf = (dir: string): string[] =>
        readdirSync(dir, { recursive: true, withFileTypes: true })
            .filter(entry => entry.isFile())
            .map(entry => join(entry.parentPath, entry.name).slice(dir.length + 1))
            .sort();

    test('copies the manifest and the skills, nothing else, into a folder named by a content hash', () => {
        const dataDir = tempDir();
        const { dir, hash } = materializeSystemSkills(source(), dataDir);

        expect(dir).toBe(join(dataDir, 'system-skills', hash));
        expect(hash).toMatch(/^[0-9a-f]{16}$/);
        expect(filesOf(dir)).toEqual([
            '.claude-plugin/plugin.json',
            'skills/orchestrate/SKILL.md',
            'skills/orchestrate/references/fan-out.md',
        ]);
        expect(JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('clowdy');
    });

    test('the copied files are read-only', () => {
        const { dir } = materializeSystemSkills(source(), tempDir());

        for (const file of filesOf(dir)) {
            expect(statSync(join(dir, file)).mode & 0o222).toBe(0);
        }

        expect(() => writeFileSync(join(dir, 'skills', 'orchestrate', 'SKILL.md'), 'edited')).toThrow();
    });

    test('the same content gives the same folder, and a change gives a new one', () => {
        const dataDir = tempDir();
        const one = source('one');
        const first = materializeSystemSkills(one, dataDir);

        expect(materializeSystemSkills(one, dataDir)).toEqual(first);
        expect(materializeSystemSkills(source('one'), dataDir)).toEqual(first);
        expect(materializeSystemSkills(source('two'), dataDir).hash).not.toBe(first.hash);
    });

    test('a copy someone changed is made again from the source', () => {
        const dataDir = tempDir();
        const original = source();
        const { dir } = materializeSystemSkills(original, dataDir);
        const skill = join(dir, 'skills', 'orchestrate', 'SKILL.md');
        const content = readFileSync(skill, 'utf8');

        writeFileSync(join(dir, 'skills', 'extra.md'), 'planted');
        Bun.spawnSync(['chmod', 'u+w', skill]);
        writeFileSync(skill, 'tampered');

        expect(materializeSystemSkills(original, dataDir).dir).toBe(dir);
        expect(readFileSync(skill, 'utf8')).toBe(content);
        expect(existsSync(join(dir, 'skills', 'extra.md'))).toBe(false);
    });

    test('keeps the newest two copies and removes the rest', () => {
        const dataDir = tempDir();
        const copies = ['one', 'two', 'three', 'four'].map((version, index) => {
            const { dir } = materializeSystemSkills(source(version), dataDir);

            utimesSync(dir, new Date(1_000_000 + index * 1000), new Date(1_000_000 + index * 1000));

            return dir;
        });

        expect(readdirSync(join(dataDir, 'system-skills')).sort()).toEqual(
            copies
                .slice(2)
                .map(dir => dir.split('/').at(-1) as string)
                .sort()
        );
    });

    test('an older copy that is used again is kept over a newer one that is not', () => {
        const dataDir = tempDir();
        const [one, two, three] = ['one', 'two', 'three'].map(version => source(version));
        const first = materializeSystemSkills(one, dataDir).dir;

        utimesSync(first, new Date(1_000_000), new Date(1_000_000));

        const second = materializeSystemSkills(two, dataDir).dir;

        utimesSync(second, new Date(2_000_000), new Date(2_000_000));
        materializeSystemSkills(one, dataDir);
        materializeSystemSkills(three, dataDir);

        expect(existsSync(first)).toBe(true);
        expect(existsSync(second)).toBe(false);
    });

    test('refuses a source without the manifest or with another plugin name, and says how to fix it', () => {
        expect(() => materializeSystemSkills(join(tempDir(), 'missing'), tempDir())).toThrow(
            /CLOWDY_SYSTEM_SKILLS_DIR/
        );
        expect(() => materializeSystemSkills(source('one', 'other'), tempDir())).toThrow('must be named "clowdy"');
    });

    test('the repository ships the plugin the daemon expects', () => {
        const { dir } = materializeSystemSkills(defaultSystemSkillsSource(), tempDir());
        const skills = readdirSync(join(dir, 'skills')).sort();

        // `orchestrate` is in every run's system prompt, and `thread` in a thread's too (`skillPrompt`).
        for (const skill of ['autopilot', 'docs', 'orchestrate', 'scaffold', 'semi-manual', 'thread']) {
            expect(skills).toContain(skill);
        }

        expect(new SkillScanner().scan(join(dir, 'skills')).warnings).toEqual([]);
    });
});
