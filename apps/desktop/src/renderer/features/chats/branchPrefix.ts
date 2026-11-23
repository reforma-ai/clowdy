import { branchPrefixOf, branchPrefixProblem, DEFAULT_BRANCH_PREFIX } from '@clowdy/protocol';
import { makeAutoObservable } from 'mobx';

import { browserStorage, readStored, writeStored, type KeyValueStorage } from '../../stores/storage';

import type { ChatWorkspaceChoice } from '@clowdy/protocol';

const STORAGE_KEY = 'clowdy:branch-prefix';

/**
 * What the branch of a new worktree starts with (`<prefix>/<chat id8>`), a preference of this computer (Settings > Chat): `clowdy` until the person chooses another.
 * The daemon keeps no settings of the app, so the app sends it with `chat.create`; only a worktree made from now on follows it, and no branch is ever renamed. What is
 * kept is always a prefix the daemon takes: a stored value it would refuse reads as the default.
 */
export class BranchPrefixPreference {
    value: string;
    readonly #storage: KeyValueStorage | undefined;

    constructor(storage: KeyValueStorage | undefined) {
        const stored = readStored(storage, STORAGE_KEY);

        this.#storage = storage;
        this.value = typeof stored === 'string' && branchPrefixProblem(stored) === undefined ? branchPrefixOf(stored) : DEFAULT_BRANCH_PREFIX;
        makeAutoObservable(this);
    }

    /** Keeps `text` (empty: the default) and says nothing, or says why the daemon would refuse it and keeps what it had. */
    setValue(text: string): string | undefined {
        const problem = branchPrefixProblem(text);

        if (problem) return problem;

        this.value = branchPrefixOf(text);
        writeStored(this.#storage, STORAGE_KEY, this.value);

        return undefined;
    }

    /**
     * The choice as `chat.create` carries it: a copy, with the prefix when the choice is a new worktree and the prefix is not the default (a daemon that is older
     * than the setting knows no such field, and the default is what it does without one).
     */
    withPrefix(choice: ChatWorkspaceChoice): ChatWorkspaceChoice {
        return choice.mode === 'new' && this.value !== DEFAULT_BRANCH_PREFIX ? { ...choice, branchPrefix: this.value } : { ...choice };
    }
}

export const branchPrefix = new BranchPrefixPreference(browserStorage());
