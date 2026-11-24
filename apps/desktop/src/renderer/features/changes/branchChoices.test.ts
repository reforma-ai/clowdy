import { describe, expect, it } from 'vitest';

import { branchOptions, canCreate, heldRowWords, heldWords, newBranchStarts, START_WORDS } from './branchChoices';

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

const rowsOf = (options: ReturnType<typeof branchOptions>) => options.map(({ id, label, group }) => [id, label, group]);

describe('branchOptions', () => {
    it('pins the default branch, keeps recent branches together, and prefers local names', () => {
        const options = branchOptions(
            listing({
                remote: [{ name: 'main' }, { name: 'dev' }, { name: 'feature/search' }, { name: 'release/2.1' }],
            })
        );

        expect(rowsOf(options)).toEqual([
            ['main', 'main', undefined],
            ['dev', 'dev', 'Recent'],
            ['feature/menu', 'feature/menu', 'Other branches'],
            ['old/idea', 'old/idea', 'Other branches'],
            ['feature/search', 'origin/feature/search', 'Other branches'],
            ['release/2.1', 'origin/release/2.1', 'Other branches'],
        ]);
    });

    it('pins the remote-only default branch above the rest in an unheaded list without recents', () => {
        const options = branchOptions(
            listing({
                local: [{ name: 'feature/menu', current: true }],
                remote: [{ name: 'trunk', default: true }, { name: 'other' }],
                recent: [],
                defaultBranch: 'trunk',
            })
        );

        expect(rowsOf(options)).toEqual([
            ['trunk', 'origin/trunk', undefined],
            ['feature/menu', 'feature/menu', undefined],
            ['other', 'origin/other', undefined],
        ]);
    });

    it('shows a single branch without any headings and no rows for an empty repository', () => {
        const options = branchOptions(
            listing({ remote: [], recent: [], local: [{ name: 'main', current: true, default: true }] })
        );
        expect(rowsOf(options)).toEqual([['main', 'main', undefined]]);
        expect(branchOptions(listing({ local: [], remote: [], recent: [] }))).toEqual([]);
    });

    it('puts branches held by another worktree after every available choice, including a held default or recent branch', () => {
        const options = branchOptions(
            listing({
                local: [
                    { name: 'feature/menu', current: true },
                    {
                        name: 'dev',
                        heldBy: { path: '/Users/dev/Clowdy/workspaces/app/ab12cd34/app', workspaceId: 'wks_1' },
                    },
                    { name: 'old/idea', heldBy: { path: '/Users/dev/app-idea' } },
                    { name: 'main', default: true, heldBy: { path: '/Users/dev/app', main: true } },
                ],
                remote: [{ name: 'dev' }, { name: 'release/2.1' }],
            }),
            '/Users/dev'
        );
        const held = options.filter(option => option.isDisabled);

        expect(rowsOf(options)).toEqual([
            ['feature/menu', 'feature/menu', undefined],
            ['release/2.1', 'origin/release/2.1', undefined],
            ['main', 'main', 'Unavailable'],
            ['dev', 'dev', 'Unavailable'],
            ['old/idea', 'old/idea', 'Unavailable'],
        ]);
        expect(held.map(option => option.description)).toEqual([
            'Checked out in the main worktree',
            'Checked out in ~/Clowdy/…/ab12cd34/app',
            'Checked out in ~/app-idea',
        ]);
        expect(held.every(option => option.stacked)).toBe(true);
        expect(options.filter(option => !option.isDisabled).every(option => option.description === undefined)).toBe(
            true
        );
    });
});

describe('heldWords', () => {
    it("is the words of the daemon's refusal, with the path as the person knows it", () => {
        expect(heldWords({ path: '/Users/dev/work/app' }, '/Users/dev')).toBe('Checked out in ~/work/app');
        expect(heldWords({ path: '/srv/app' }, '/Users/dev')).toBe('Checked out in /srv/app');
        expect(heldWords({ path: '/srv/app' }, undefined)).toBe('Checked out in /srv/app');
        expect(heldWords({ path: '/Users/dev/app', main: true }, '/Users/dev')).toBe(
            'Checked out in the main worktree'
        );
    });
});

describe('heldRowWords', () => {
    it('is heldWords while the path fits, and else keeps the start and the end of the path, which the row would cut at the end', () => {
        expect(heldRowWords({ path: '/Users/dev/work/app' }, '/Users/dev')).toBe(
            heldWords({ path: '/Users/dev/work/app' }, '/Users/dev')
        );
        expect(heldRowWords({ path: '/Users/dev/app', main: true }, '/Users/dev')).toBe(
            'Checked out in the main worktree'
        );
        expect(
            heldRowWords({ path: '/Users/dev/Clowdy/workspaces/car-rental/ab12cd34/car-rental' }, '/Users/dev')
        ).toBe('Checked out in ~/…/ab12cd34/car-rental');
        // A path that no form shortens enough keeps its last names, the way `PathText` does.
        expect(
            heldRowWords(
                { path: '/a-very-long-name-of-a-folder-that-has-no-end-in-sight/another-one-as-long-as-that' },
                undefined
            )
        ).toBe('Checked out in …/another-one-as-long-as-that');
    });
});

describe('the form of a new branch', () => {
    it('names the two starts as GitHub Desktop does, with the branches they are now', () => {
        const starts = newBranchStarts(listing(), { kind: 'branch', name: 'feature/menu', commit: 'a'.repeat(40) });

        expect(starts).toEqual({ default: 'main', current: 'feature/menu' });
        expect(START_WORDS.default.label(starts.default)).toBe('The default branch (main)');
        expect(START_WORDS.current.label(starts.current)).toBe('The current branch (feature/menu)');
        expect(START_WORDS.default.description).toBe(
            "The default branch in your repository. Pick this to start on something new that's not dependent on your current branch."
        );
        expect(START_WORDS.current.description).toBe(
            'The currently checked out branch. Pick this if you need to build on work done on this branch.'
        );
    });

    it('names a detached HEAD by its commit, and has no start for what the repository does not have', () => {
        expect(
            newBranchStarts(listing({ defaultBranch: undefined }), { kind: 'detached', commit: '1234567890abcdef' })
        ).toEqual({ current: '1234567' });
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
