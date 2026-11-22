import { makeAutoObservable, observableShallow, runInAction } from 'mobx';

/** One reversible change. It knows how to undo itself, so the stack knows nothing about what the change was. */
export interface UndoEntry {
    /**
     * Whose history the change belongs to (a project id): `Cmd+Z` takes back only the changes made where the person is,
     * so it never reverts something in a project that is not on screen.
     */
    scope: string;
    /** The change in words ("CAR-12 moved to In progress"), for whatever offers the undo. */
    label: string;
    /** Reverses the change and resolves to whether it did. It tells the person itself why it could not: the stack shows nothing. */
    undo: () => Promise<boolean>;
}

/** How many changes of one scope can be taken back. A person who goes further than this is not undoing, they are restoring. */
export const UNDO_LIMIT = 50;

/**
 * The changes a person can take back, the latest last, each in the scope (a project) it was made in. It is not about tasks or any other section:
 * an entry is a scope, a label and a function. Undos run one at a time, so two quick presses do not interleave their commands, and each one sees what the one before it did.
 */
export class UndoStack {
    /** Oldest first. */
    entries: UndoEntry[] = [];

    /** The undo that is running or ran last. It never rejects, so it can be chained. */
    #tail: Promise<unknown> = Promise.resolve();

    constructor(readonly limit = UNDO_LIMIT) {
        makeAutoObservable(this, { limit: false, entries: observableShallow, canUndo: false, undoEntry: false, undoLatest: false });
    }

    /**
     * Whether the scope has something to undo. A command that is on only then (the hints read it) follows this.
     * A method rather than an action, so a reaction that calls it tracks the entries.
     */
    canUndo(scope: string): boolean {
        return this.entries.some(entry => entry.scope === scope);
    }

    /** Records a change that has been made. The oldest one of its scope is forgotten once the scope has more than `limit`. */
    push(entry: UndoEntry): void {
        this.entries.push(entry);

        const own = this.entries.filter(candidate => candidate.scope === entry.scope);

        if (own.length > this.limit) {
            const drop = new Set(own.slice(0, own.length - this.limit));

            this.entries = this.entries.filter(candidate => !drop.has(candidate));
        }
    }

    /** Takes back the latest change of the scope. Resolves to whether there was one and it worked. */
    undoLatest(scope: string): Promise<boolean> {
        const latest = this.entries.findLast(entry => entry.scope === scope);

        return latest ? this.undoEntry(latest) : Promise.resolve(false);
    }

    /**
     * Takes back one change, whichever it is: a toast offers the undo of its own change, which may not be the latest by now.
     * The entry leaves the stack at once, so it cannot run twice, and resolves to false when it was not there.
     */
    undoEntry(entry: UndoEntry): Promise<boolean> {
        const index = this.entries.indexOf(entry);

        if (index < 0) return Promise.resolve(false);

        runInAction(() => this.entries.splice(index, 1));

        const run = this.#tail.then(async () => {
            try {
                return await entry.undo();
            }
            catch (error) {
                // A broken undo must not stop the ones queued behind it.
                console.error(error);

                return false;
            }
        });

        this.#tail = run;

        return run;
    }

    /** Forgets everything. An undo that is running goes on. */
    clear(): void {
        this.entries.splice(0);
    }
}

/** An isolated stack, for tests and for a part of the app that wants its own history. */
export const createUndoStack = (limit?: number) => new UndoStack(limit);

/**
 * The window's undo history. A singleton like `hotkeys`: the key and the toast's button that raise and use an entry live in different components
 * (and a toast outlives the screen that showed it), and they must see the same stack.
 */
export const undoStack = createUndoStack();
