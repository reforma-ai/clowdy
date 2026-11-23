import { describe, expect, it } from 'vitest';

import { BRANCH_GROUPS, branchOptions, canCreate, heldRowWords, heldWords, newBranchStarts, START_WORDS, WORKTREE_KEEPS_BRANCH } from './branchChoices';

import type { BranchListing } from './branchChoices';

const listing = (overrides: Partial<BranchListing> = {}): BranchListing => ({
    isRepository: true,
    defaultBranch: 'main',
    local: [
        { name: 'feature/menu', current: true },
        { name: 'dev', upstream: 'origin/dev' },
        { name: 'main', default: true, upstream: 'origin/main' },
        { name: 'old/idea' },
    ],
    remote: [{ name: 'feature/search' }, { name: 'release/2.1' }],
    recent: ['dev', 'main'],
    ...overrides,
});

const groupsOf = (options: ReturnType<typeof branchOptions>) => Object.fromEntries([...new Set(options.map(option => option.group))].map(group => [group, options.filter(option => option.group === group).map(option => option.id)]));

describe('branchOptions', () => {
    it('lists each branch once, in the groups Default, Recent, Local and Remote, in that order', () => {
        const options = branchOptions(listing());

        expect(Object.keys(groupsOf(options))).toEqual([BRANCH_GROUPS.default, BRANCH_GROUPS.recent, BRANCH_GROUPS.local, BRANCH_GROUPS.remote]);
        expect(groupsOf(options)).toEqual({
            Default: ['main'],
            // The default branch is under Default alone, whether or not HEAD was on it lately.
            Recent: ['dev'],
            Local: ['feature/menu', 'old/idea'],
            Remote: ['feature/search', 'release/2.1'],
        });
        expect(new Set(options.map(option => option.id)).size).toBe(options.length);
    });

    it('puts the default branch under Default when it is a branch only origin has, and then not again under Remote', () => {
        const options = branchOptions(listing({ local: [{ name: 'feature/menu', current: true }], remote: [{ name: 'trunk', default: true }, { name: 'other' }], recent: [], defaultBranch: 'trunk' }));

        expect(groupsOf(options)).toEqual({ Default: ['trunk'], Local: ['feature/menu'], Remote: ['other'] });
    });

    it('leaves a group out when it has no branch', () => {
        expect(Object.keys(groupsOf(branchOptions(listing({ remote: [], recent: [], local: [{ name: 'main', current: true, default: true }] }))))).toEqual(['Default']);
        expect(branchOptions(listing({ local: [], remote: [], recent: [] }))).toEqual([]);
    });

    it('shows a branch that another worktree has as a dimmed row that says where, in whichever group it falls', () => {
        const options = branchOptions(listing({
            local: [
                { name: 'feature/menu', current: true },
                { name: 'dev', heldBy: { path: '/Users/dev/Clowdy/workspaces/app/ab12cd34/app', workspaceId: 'wks_1' } },
                { name: 'old/idea', heldBy: { path: '/Users/dev/app-idea' } },
                { name: 'main', default: true, heldBy: { path: '/Users/dev/app', main: true } },
            ],
        }), '/Users/dev');
        const held = options.filter(option => option.isDisabled);

        expect(held.map(option => [option.id, option.group, option.description])).toEqual([
            ['main', 'Default', 'Checked out in the main worktree'],
            ['dev', 'Recent', 'Checked out in ~/Clowdy/…/ab12cd34/app'],
            ['old/idea', 'Local', 'Checked out in ~/app-idea'],
        ]);
        expect(held.every(option => option.stacked)).toBe(true);
        expect(options.filter(option => !option.isDisabled).every(option => option.description === undefined)).toBe(true);
    });
});

describe('heldWords', () => {
    it('is the words of the daemon\'s refusal, with the path as the person knows it', () => {
        expect(heldWords({ path: '/Users/dev/work/app' }, '/Users/dev')).toBe('Checked out in ~/work/app');
        expect(heldWords({ path: '/srv/app' }, '/Users/dev')).toBe('Checked out in /srv/app');
        expect(heldWords({ path: '/srv/app' }, undefined)).toBe('Checked out in /srv/app');
        expect(heldWords({ path: '/Users/dev/app', main: true }, '/Users/dev')).toBe('Checked out in the main worktree');
    });
});

describe('heldRowWords', () => {
    it('is heldWords while the path fits, and else keeps the start and the end of the path, which the row would cut at the end', () => {
        expect(heldRowWords({ path: '/Users/dev/work/app' }, '/Users/dev')).toBe(heldWords({ path: '/Users/dev/work/app' }, '/Users/dev'));
        expect(heldRowWords({ path: '/Users/dev/app', main: true }, '/Users/dev')).toBe('Checked out in the main worktree');
        expect(heldRowWords({ path: '/Users/dev/Clowdy/workspaces/car-rental/ab12cd34/car-rental' }, '/Users/dev')).toBe('Checked out in ~/…/ab12cd34/car-rental');
        // A path that no form shortens enough keeps its last names, the way `PathText` does.
        expect(heldRowWords({ path: '/a-very-long-name-of-a-folder-that-has-no-end-in-sight/another-one-as-long-as-that' }, undefined)).toBe('Checked out in …/another-one-as-long-as-that');
    });
});

describe('the form of a new branch', () => {
    it('names the two starts as GitHub Desktop does, with the branches they are now', () => {
        const starts = newBranchStarts(listing(), { kind: 'branch', name: 'feature/menu', commit: 'a'.repeat(40) });

        expect(starts).toEqual({ default: 'main', current: 'feature/menu' });
        expect(START_WORDS.default.label(starts.default)).toBe('The default branch (main)');
        expect(START_WORDS.current.label(starts.current)).toBe('The current branch (feature/menu)');
        expect(START_WORDS.default.description).toBe('The default branch in your repository. Pick this to start on something new that\'s not dependent on your current branch.');
        expect(START_WORDS.current.description).toBe('The currently checked out branch. Pick this if you need to build on work done on this branch.');
    });

    it('names a detached HEAD by its commit, and has no start for what the repository does not have', () => {
        expect(newBranchStarts(listing({ defaultBranch: undefined }), { kind: 'detached', commit: '1234567890abcdef' })).toEqual({ current: '1234567' });
        expect(newBranchStarts(undefined, undefined)).toEqual({});
        expect(START_WORDS.default.label(undefined)).toBe('The default branch');
    });

    it('can be created once a name is typed and the chosen start has a branch', () => {
        expect(canCreate('feature/x', 'default', { default: 'main', current: 'dev' })).toBe(true);
        expect(canCreate('  ', 'default', { default: 'main' })).toBe(false);
        expect(canCreate('', 'current', { current: 'dev' })).toBe(false);
        expect(canCreate('x', 'default', { current: 'dev' })).toBe(false);
    });
});

describe('WORKTREE_KEEPS_BRANCH', () => {
    it('is the daemon\'s own reason, with no period', () => {
        expect(WORKTREE_KEEPS_BRANCH).toBe('A chat\'s worktree keeps its branch');
    });
});
