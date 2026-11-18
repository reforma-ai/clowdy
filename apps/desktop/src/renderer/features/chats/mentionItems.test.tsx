import { describe, expect, it } from 'vitest';

import { docItems, docPaths, skillItems, skillName, taskItems } from './mentionItems';

import type { DocNode, SkillEntry, Task } from '@clowdy/protocol';

const task = (number: number, title: string): Task => ({ id: `t-${ number }`, number, key: `CAR-${ number }`, title }) as Task;
const skill = (name: string, source: SkillEntry['source'], fields: Partial<SkillEntry> = {}): SkillEntry => ({
    id: `${ source }:${ name }`,
    name,
    source,
    description: `${ name } skill`,
    enabled: true,
    tokens: 20,
    engines: [],
    ...fields,
});

describe('taskItems', () => {
    const tasks = [task(20, 'Move availability into one API call'), task(24, 'Rebuild the form as one view'), task(25, 'Send a confirmation email')];

    it('lists the newest first when nothing is typed', () => {
        expect(taskItems(tasks, '').map(item => item.label)).toEqual(['CAR-25', 'CAR-24', 'CAR-20']);
    });

    it('finds a task by a word of its title or by its key, in any case', () => {
        expect(taskItems(tasks, 'FORM').map(item => item.label)).toEqual(['CAR-24']);
        expect(taskItems(tasks, 'car-2 one').map(item => item.label)).toEqual(['CAR-24', 'CAR-20']);
        expect(taskItems(tasks, 'nothing like it')).toEqual([]);
    });

    it('carries the key for the message and the title for the hover', () => {
        expect(taskItems(tasks, '25')[0]).toMatchObject({ kind: 'task', section: 'Tasks', displayText: 'CAR-25', data: { key: 'CAR-25', title: 'Send a confirmation email' } });
    });
});

describe('docs', () => {
    const tree: DocNode[] = [
        { path: 'decisions', name: 'decisions', kind: 'dir', children: [{ path: 'decisions/pricing.md', name: 'pricing.md', kind: 'file' }] },
        { path: 'README.md', name: 'README.md', kind: 'file' },
    ];

    it('flattens a tree to the paths of its files', () => {
        expect(docPaths(tree)).toEqual(['decisions/pricing.md', 'README.md']);
    });

    it('offers a document by the path from the project folder, under its docs folder', () => {
        expect(docItems(docPaths(tree), 'pric')).toMatchObject([{ label: 'pricing.md', description: 'decisions', kind: 'doc', section: 'Documents', data: { path: '.clowdy/docs/decisions/pricing.md' } }]);
    });
});

describe('skillItems', () => {
    const entries = [
        skill('clowdy:orchestrate', 'system'),
        skill('user:deploy', 'user'),
        skill('deploy', 'project'),
        skill('user:lint', 'user', { enabled: false }),
        skill('review', 'project', { description: 'Reviews a diff' }),
    ];

    it('names a user skill by its folder', () => {
        expect(skillName({ name: 'user:deploy' })).toBe('deploy');
        expect(skillName({ name: 'review' })).toBe('review');
    });

    it('leaves out system skills and skills that are off, and lists a shared name once', () => {
        expect(skillItems(entries, '').map(item => item.label)).toEqual(['/deploy', '/review']);
    });

    it('searches the name and the description', () => {
        expect(skillItems(entries, 'diff').map(item => item.label)).toEqual(['/review']);
    });

    it('carries the name the message asks for', () => {
        expect(skillItems(entries, 'review')[0]).toMatchObject({ kind: 'command', displayText: '/review', data: { name: 'review' } });
    });
});
