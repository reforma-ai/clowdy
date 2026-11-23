import { describe, expect, it } from 'vitest';

import { BranchPrefixPreference } from './branchPrefix';

const memory = () => {
    const values = new Map<string, string>();

    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
};

describe('The branch prefix of a new worktree', () => {
    it('is clowdy by default, and remembers a choice on this computer', () => {
        const storage = memory();

        expect(new BranchPrefixPreference(storage).value).toBe('clowdy');
        expect(new BranchPrefixPreference(storage).setValue(' max ')).toBeUndefined();
        expect(storage.getItem('clowdy:branch-prefix')).toBe('"max"');
        expect(new BranchPrefixPreference(storage).value).toBe('max');
    });

    it('takes an empty text as the default again', () => {
        const storage = memory();
        const preference = new BranchPrefixPreference(storage);

        preference.setValue('max');
        expect(preference.setValue('  ')).toBeUndefined();
        expect(preference.value).toBe('clowdy');
        expect(new BranchPrefixPreference(storage).value).toBe('clowdy');
    });

    it('says why a prefix is refused and keeps the one it had', () => {
        const storage = memory();
        const preference = new BranchPrefixPreference(storage);

        preference.setValue('max');

        expect(preference.setValue('two words')).toBe('The branch prefix cannot have a space or a control character');
        expect(preference.setValue('a..b')).toBe('The branch prefix cannot have two dots in a row');
        expect(preference.value).toBe('max');
        expect(new BranchPrefixPreference(storage).value).toBe('max');
    });

    it('reads anything it did not write, or the daemon would refuse, as the default', () => {
        for (const stored of ['"two words"', '"/x"', '7', 'null', '{"a":1}', 'not json']) {
            const storage = memory();

            storage.setItem('clowdy:branch-prefix', stored);

            expect(new BranchPrefixPreference(storage).value).toBe('clowdy');
        }
    });

    it('works without storage', () => {
        const preference = new BranchPrefixPreference(undefined);

        preference.setValue('max');

        expect(preference.value).toBe('max');
    });

    it('puts the prefix on a new worktree\'s choice when it is not the default, and leaves every other choice as it is', () => {
        const preference = new BranchPrefixPreference(undefined);
        const existing = { mode: 'existing', path: '/work/p-feature' } as const;
        const fresh = { mode: 'new', base: 'dev' } as const;

        expect(preference.withPrefix(fresh)).toEqual({ mode: 'new', base: 'dev' });
        preference.setValue('max');
        expect(preference.withPrefix(fresh)).toEqual({ mode: 'new', base: 'dev', branchPrefix: 'max' });
        expect(preference.withPrefix({ mode: 'new' })).toEqual({ mode: 'new', branchPrefix: 'max' });
        expect(preference.withPrefix(existing)).toEqual(existing);
        // A copy: the store keeps the choice it holds.
        expect(preference.withPrefix(fresh)).not.toBe(fresh);
        expect(fresh).toEqual({ mode: 'new', base: 'dev' });
    });
});
