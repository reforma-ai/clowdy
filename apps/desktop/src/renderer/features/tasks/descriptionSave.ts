/** A checklist line's marker and box, in any of the forms the checklist parser reads: `- [ ]`, `* [x]`, `+ [X]`, and the ordered `1. [ ]` a person may have written. */
const BOX = /^(\s*(?:[-+*]|\d+[.)])\s+)\[[ xX]\]/gm;

const unticked = (text: string) => text.replace(BOX, '$1[ ]');

/**
 * Whether `after` is `before` with checklist boxes ticked or unticked and nothing else changed: what a click on a checkbox does to the description.
 * The editor reports every change as the whole new text, so this is how a tick is told from typing.
 */
export function onlyTicksChanged(before: string, after: string): boolean {
    return before !== after && unticked(before) === unticked(after);
}

/**
 * Sends the text of a field one save at a time, in the order the person made them, so that an older text can never land after a newer one. While a save is
 * on its way the newest text waits and is sent next; the texts between are dropped, since the newest holds them all. A text equal to the one sent last is not
 * sent again, unless the project has shown something else since (`noteStored`): someone else changed the field, and the last save is not what is there.
 */
export class LatestSaver {
    #isBusy = false;
    #pending: string | undefined;
    #lastSent: string | undefined;

    /**
     * @param send Saves the text and resolves to whether it was taken. Called with one text at a time.
     * @param onRefused Runs when a save was not taken: the texts waiting are dropped, and the caller puts the field back to what is stored.
     */
    constructor(
        private readonly send: (text: string) => Promise<boolean>,
        private readonly onRefused: () => void
    ) {}

    /** A save is on its way or waiting. */
    get isBusy(): boolean {
        return this.#isBusy;
    }

    /** What the project holds now. A text sent before that differs from it is no longer what the daemon has. */
    noteStored(text: string): void {
        if (text !== this.#lastSent) this.#lastSent = undefined;
    }

    /** Saves the text: now, or after the save that is on its way. Resolves once nothing is waiting. */
    async save(text: string): Promise<void> {
        this.#pending = text;

        if (this.#isBusy) return;

        this.#isBusy = true;

        try {
            while (this.#pending !== undefined) {
                const next = this.#pending;

                this.#pending = undefined;

                if (next === this.#lastSent) continue;

                if (await this.send(next)) {
                    this.#lastSent = next;
                } else {
                    this.#pending = undefined;
                    this.onRefused();
                }
            }
        } finally {
            this.#isBusy = false;
        }
    }
}
