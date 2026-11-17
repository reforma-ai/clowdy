import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isValidSkillName, MAX_DESCRIPTION_CHARS, parseSkillFile } from '../src/skills/frontmatter';
import { MAX_SKILL_BYTES, MAX_SKILLS_PER_ROOT, SkillScanner } from '../src/skills/scan';
import { cleanTempDirs, tempDir } from './helpers';
import { writeSkill } from './skill-helpers';

afterAll(cleanTempDirs);

const file = (front: string, body = '# Body\n') => `---\n${ front }\n---\n${ body }`;

describe('front matter', () => {
    test('reads plain, double-quoted and single-quoted values', () => {
        expect(parseSkillFile(file('name: a\ndescription: Plain words'), 'a')).toEqual({ ok: true, description: 'Plain words', truncated: false });
        expect(parseSkillFile(file('description: "Use when: asked to deploy"'), 'a')).toMatchObject({ ok: true, description: 'Use when: asked to deploy' });
        expect(parseSkillFile(file('description: \'It\'\'s fine\''), 'a')).toMatchObject({ ok: true, description: 'It\'s fine' });
    });

    test('folds block scalars and collapses whitespace into one line', () => {
        expect(parseSkillFile(file('description: >\n  First line\n  second line'), 'a')).toMatchObject({ ok: true, description: 'First line second line' });
        expect(parseSkillFile(file('description: |\n  Kept\n\n  apart'), 'a')).toMatchObject({ ok: true, description: 'Kept apart' });
    });

    test('accepts a byte order mark and CRLF line ends', () => {
        expect(parseSkillFile('﻿---\r\nname: a\r\ndescription: Windows file\r\n---\r\nBody', 'a')).toMatchObject({ ok: true, description: 'Windows file' });
    });

    test('ignores keys it does not know, including nested ones', () => {
        const raw = file('name: a\ndescription: Works\nallowed-tools: Read, Bash\ndisable-model-invocation: true\nmetadata:\n  short-description: x\n  tags: [1, 2]');

        expect(parseSkillFile(raw, 'a')).toMatchObject({ ok: true, description: 'Works' });
    });

    test('a name that is given must match the folder', () => {
        expect(parseSkillFile(file('name: other\ndescription: Works'), 'a')).toEqual({ ok: false, reason: 'its name "other" differs from the folder name' });
        expect(parseSkillFile(file('name: 12\ndescription: Works'), '12')).toMatchObject({ ok: true });
    });

    test('says why a file is not a skill', () => {
        expect(parseSkillFile('# Just text', 'a')).toMatchObject({ ok: false, reason: expect.stringContaining('no front matter') });
        expect(parseSkillFile('---\nname: a\ndescription: never closed\n', 'a')).toMatchObject({ ok: false, reason: expect.stringContaining('no front matter') });
        expect(parseSkillFile('---\n---\nBody', 'a')).toMatchObject({ ok: false, reason: 'it has no description' });
        expect(parseSkillFile(file('name: a'), 'a')).toMatchObject({ ok: false, reason: 'it has no description' });
        expect(parseSkillFile(file('description: "   "'), 'a')).toMatchObject({ ok: false, reason: 'it has no description' });
        expect(parseSkillFile(file('description: [one, two]'), 'a')).toMatchObject({ ok: false, reason: 'it has no description' });
        expect(parseSkillFile(file('- a\n- b'), 'a')).toMatchObject({ ok: false, reason: expect.stringContaining('key: value') });
    });

    test('an unquoted colon is invalid YAML, and the reason says to quote it', () => {
        expect(parseSkillFile(file('description: Use when: asked'), 'a')).toMatchObject({ ok: false, reason: expect.stringContaining('quote') });
        expect(parseSkillFile(file('description: [unclosed'), 'a')).toMatchObject({ ok: false, reason: expect.stringContaining('not valid YAML') });
    });

    test('cuts a long description like the engines do', () => {
        const parsed = parseSkillFile(file(`description: ${ 'x'.repeat(MAX_DESCRIPTION_CHARS + 50) }`), 'a');

        expect(parsed).toMatchObject({ ok: true, truncated: true });
        expect(parsed.ok && parsed.description).toHaveLength(MAX_DESCRIPTION_CHARS);
    });

    test('a name is a plain word of at most 64 characters', () => {
        for (const name of ['deploy', 'Deploy_2', 'a.b-c', '7zip']) {
            expect(isValidSkillName(name)).toBe(true);
        }

        for (const name of ['', '.hidden', 'has space', 'a/b', 'a\\b', 'a..b', 'naïve', 'a'.repeat(65)]) {
            expect(isValidSkillName(name)).toBe(false);
        }
    });
});

describe('scanning a skills folder', () => {
    test('a folder that does not exist has no skills', () => {
        expect(new SkillScanner().scan(join(tempDir(), 'nope'))).toMatchObject({ skills: [], warnings: [] });
    });

    test('finds the direct children that hold a SKILL.md, by name', () => {
        const root = tempDir();

        writeSkill(root, 'zeta');
        writeSkill(root, 'alpha', 'The first one');
        mkdirSync(join(root, 'empty'));
        writeFileSync(join(root, 'SKILL.md'), '---\ndescription: the root itself\n---\n');
        writeFileSync(join(root, 'notes.md'), 'not a skill');

        const { skills, warnings } = new SkillScanner().scan(root);

        expect(skills.map(skill => skill.folder)).toEqual(['alpha', 'zeta']);
        expect(skills[0]).toMatchObject({ description: 'The first one', dir: join(root, 'alpha') });
        expect(warnings).toEqual([]);
    });

    test('does not look inside hidden folders, node_modules or other skills', () => {
        const root = tempDir();

        writeSkill(root, '.hidden');
        writeSkill(root, 'node_modules');
        writeSkill(root, join('group', 'inner'));
        writeSkill(join(root, 'outer'), 'nested');
        writeSkill(root, 'outer');

        expect(new SkillScanner().scan(root).skills.map(skill => skill.folder)).toEqual(['outer']);
    });

    test('follows a symlink to a skill folder and names the skill by the link', () => {
        const root = tempDir();
        const elsewhere = writeSkill(join(tempDir(), 'shared'), 'linked');

        symlinkSync(elsewhere, join(root, 'linked'), 'dir');
        symlinkSync(join(root, 'missing'), join(root, 'broken'), 'dir');

        const { skills } = new SkillScanner().scan(root);

        expect(skills.map(skill => skill.folder)).toEqual(['linked']);
        expect(skills[0]).toMatchObject({ dir: join(root, 'linked'), real: expect.stringMatching(/shared.linked$/) });
    });

    test('is not trapped by links that lead back to the folder or above it', () => {
        const parent = tempDir();
        const root = join(parent, 'skills');

        writeSkill(root, 'one');
        writeFileSync(join(root, 'SKILL.md'), '---\ndescription: the root is a skill too\n---\n');
        symlinkSync(root, join(root, 'self'), 'dir');
        symlinkSync(parent, join(root, 'up'), 'dir');
        writeFileSync(join(parent, 'SKILL.md'), '---\ndescription: the parent is a skill too\n---\n');
        symlinkSync(join(root, 'one'), join(root, 'one-again'), 'dir');
        mkdirSync(join(root, 'one', 'deeper'));
        symlinkSync(root, join(root, 'one', 'deeper', 'back'), 'dir');

        expect(new SkillScanner().scan(root).skills.map(skill => skill.folder)).toEqual(['one']);
    });

    test('says what it skipped and why', () => {
        const root = tempDir();

        writeSkill(root, 'fine');
        writeSkill(root, 'no-description', '', '---\nname: no-description\n---\n');
        writeSkill(root, 'not-yaml', '', '---\ndescription: Use when: x\n---\n');
        writeSkill(root, 'wrong-name', '', '---\nname: other\ndescription: x\n---\n');
        writeSkill(root, 'has space');
        writeSkill(root, 'huge', '', `---\ndescription: x\n---\n${ 'y'.repeat(MAX_SKILL_BYTES) }`);

        const { skills, warnings } = new SkillScanner().scan(root);

        expect(skills.map(skill => skill.folder)).toEqual(['fine']);
        expect(warnings).toHaveLength(5);
        expect(warnings).toContain('Skipped "no-description": it has no description');
        expect(warnings.find(warning => warning.includes('not-yaml'))).toContain('not valid YAML');
        expect(warnings.find(warning => warning.includes('wrong-name'))).toContain('differs from the folder');
        expect(warnings.find(warning => warning.includes('has space'))).toContain('letters, digits');
        expect(warnings.find(warning => warning.includes('huge'))).toContain('larger than 256 KB');
    });

    test('lists only the first skills of a huge folder and says so', () => {
        const root = tempDir();

        for (let index = 0; index < MAX_SKILLS_PER_ROOT + 3; index++) {
            writeSkill(root, `skill-${ String(index).padStart(3, '0') }`);
        }

        const { skills, warnings } = new SkillScanner().scan(root);

        expect(skills).toHaveLength(MAX_SKILLS_PER_ROOT);
        expect(skills.at(-1)?.folder).toBe(`skill-${ String(MAX_SKILLS_PER_ROOT - 1).padStart(3, '0') }`);
        expect(warnings).toEqual([`This folder holds ${ MAX_SKILLS_PER_ROOT + 3 } skills; only the first ${ MAX_SKILLS_PER_ROOT } are listed`]);
    });
});

describe('the scan cache', () => {
    const later = (path: string, seconds: number) => utimesSync(path, new Date(Date.now() + seconds * 1000), new Date(Date.now() + seconds * 1000));

    test('an untouched folder is not read again', () => {
        const root = tempDir();
        const scanner = new SkillScanner();

        writeSkill(root, 'one');

        expect(scanner.scan(root)).toBe(scanner.scan(root));
    });

    test('an edited SKILL.md is read again, even when the folder entries did not change', () => {
        const root = tempDir();
        const scanner = new SkillScanner();
        const dir = writeSkill(root, 'one', 'Before');
        const first = scanner.scan(root);

        writeSkill(root, 'one', 'After');
        later(join(dir, 'SKILL.md'), 5);

        const second = scanner.scan(root);

        expect(second).not.toBe(first);
        expect(second.skills[0].description).toBe('After');
    });

    test('a touched file is read again and gives the same skills', () => {
        const root = tempDir();
        const scanner = new SkillScanner();
        const dir = writeSkill(root, 'one');
        const first = scanner.scan(root);

        later(join(dir, 'SKILL.md'), 5);

        const second = scanner.scan(root);

        expect(second.fingerprint).not.toBe(first.fingerprint);
        expect(second.skills.map(skill => skill.description)).toEqual(first.skills.map(skill => skill.description));
    });

    test('a skill that appears or goes changes the result', () => {
        const root = tempDir();
        const scanner = new SkillScanner();

        writeSkill(root, 'one');
        expect(scanner.scan(root).skills).toHaveLength(1);

        writeSkill(root, 'two');
        expect(scanner.scan(root).skills).toHaveLength(2);

        rmSync(join(root, 'one'), { recursive: true });
        expect(scanner.scan(root).skills.map(skill => skill.folder)).toEqual(['two']);
    });

    test('a link pointed somewhere else changes the result', () => {
        const root = tempDir();
        const scanner = new SkillScanner();
        const first = writeSkill(join(tempDir(), 'a'), 'link', 'The first');
        const second = writeSkill(join(tempDir(), 'b'), 'link', 'The second');

        symlinkSync(first, join(root, 'link'), 'dir');
        expect(scanner.scan(root).skills[0].description).toBe('The first');

        rmSync(join(root, 'link'));
        symlinkSync(second, join(root, 'link'), 'dir');
        expect(scanner.scan(root).skills[0].description).toBe('The second');
    });
});
