import { action, computed, observable, observableShallow } from 'mobx';

import type { TextDocument } from './TextDocument';

/** Open tabs and the active one; what a host stores to reopen them later. */
export interface TabsSnapshot {
    paths: string[];
    active: string | null;
}

/** Open documents in tab order, and the active tab. */
export class Tabs {
    @observableShallow accessor documents: TextDocument[] = [];
    @observable accessor activePath: string | null = null;
    /** When each tab was last active, as a count of activations. */
    #lastUse = new WeakMap<TextDocument, number>();
    #uses = 0;

    @computed
    get active(): TextDocument | null {
        return this.activePath === null ? null : (this.get(this.activePath) ?? null);
    }

    get(path: string): TextDocument | undefined {
        return this.documents.find(document => document.path === path);
    }

    @action
    add(document: TextDocument): void {
        this.documents.push(document);
    }

    @action
    activate(path: string): void {
        const document = this.get(path);

        if (document) {
            this.#use(document);
        }
    }

    /** Points a tab at its file's new path after a rename or a move. */
    @action
    retarget(document: TextDocument, path: string): void {
        if (this.activePath === document.path) {
            this.activePath = path;
        }

        document.path = path;
    }

    /** Removes a tab; closing the active one activates its right neighbor, or the left one at the end. */
    @action
    remove(document: TextDocument): void {
        const index = this.documents.indexOf(document);

        if (index === -1) {
            return;
        }

        this.documents.splice(index, 1);

        if (this.activePath === document.path) {
            const next = this.documents[index] ?? this.documents[index - 1];

            if (next) {
                this.#use(next);
            } else {
                this.activePath = null;
            }
        }
    }

    /** Tabs from the least recently active; tabs never active come first, in tab order. */
    byLastUse(): TextDocument[] {
        return [...this.documents].sort((a, b) => (this.#lastUse.get(a) ?? 0) - (this.#lastUse.get(b) ?? 0));
    }

    #use(document: TextDocument): void {
        this.activePath = document.path;
        this.#lastUse.set(document, ++this.#uses);
    }

    snapshot(): TabsSnapshot {
        return {
            paths: this.documents.map(document => document.path),
            active: this.activePath,
        };
    }
}
