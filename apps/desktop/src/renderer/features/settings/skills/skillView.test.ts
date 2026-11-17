import { describe, expect, it } from 'vitest';

import { engineLabel, groupSkills, tokenLabel } from './skillView';

import type { SkillEntry } from '@clowdy/protocol';

const entry = (source: SkillEntry['source'], name: string): SkillEntry => ({ id: `${ source }:${ name }`, name, source, description: `About ${ name }`, enabled: true, tokens: 40, engines: ['claude', 'codex'] });

describe('groupSkills', () => {
    it('puts each skill in the group of its source, keeping the daemon order', () => {
        const groups = groupSkills([entry('system', 'clowdy:docs'), entry('user', 'user:b'), entry('user', 'user:a'), entry('project', 'review')], 'Car Rental');

        expect(groups.map(group => [group.source, group.skills.map(skill => skill.name)])).toEqual([
            ['system', ['clowdy:docs']],
            ['user', ['user:b', 'user:a']],
            ['project', ['review']],
        ]);
    });

    it('shows no project group without a project, and drops that source', () => {
        const groups = groupSkills([entry('system', 'clowdy:docs'), entry('project', 'review')]);

        expect(groups.map(group => group.source)).toEqual(['system', 'user']);
    });

    it('keeps an empty group, with words for the empty state', () => {
        const [, user, project] = groupSkills([], 'Car Rental');

        expect(user.skills).toEqual([]);
        expect(user.empty).toContain('~/.claude/skills');
        expect(project.empty).toContain('Car Rental has no skills of its own');
    });
});

describe('labels', () => {
    it('names the engines that see a skill', () => {
        expect(engineLabel(['claude', 'codex'])).toBe('Claude and Codex');
        expect(engineLabel(['claude'])).toBe('Claude only');
        expect(engineLabel(['codex'])).toBe('Codex only');
    });

    it('writes tokens with a thousands separator', () => {
        expect(tokenLabel(39)).toBe('39 tokens');
        expect(tokenLabel(1234)).toBe('1,234 tokens');
    });
});
