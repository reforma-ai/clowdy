import { makeAutoObservable } from 'mobx';

import type { DocFile } from '@clowdy/protocol';

/** A version of the file as it is on disk. */
export interface DiskVersion {
    content: string;
    hash: string;
}

export type BufferStatus = 'loading' | 'ready' | 'failed';

/**
 * One open document: the text being edited and how it stands against the file on disk.
 *
 * The buffer does no I/O. Its owner tells it what it learned: the file it loaded, a fresh look at the disk
 * (`observe`), the outcome of a save. The rules, in short:
 * - `edited` means the text differs from the version it started from (`savedText`). Only edited text is at risk.
 * - A disk version that changes nothing the person typed replaces the text silently. A different disk version
 *   while the text is edited becomes a `conflict`, and the text stays as it is until the person chooses.
 * - A file that vanishes leaves the text in place; `baseHash` is `null`, and a save creates the file again.
 */
export class DocBuffer {
    status: BufferStatus = 'loading';
    error = '';
    /** What the person sees and edits. */
    text = '';
    /** The text of the disk version the buffer started from, or last saved. */
    savedText = '';
    /** The hash of that version; `null` once the file is gone from disk. */
    baseHash: string | null = null;
    /** The file vanished from disk while it was open. */
    removed = false;
    /** The disk's version, when it differs from both the base and the edited text. */
    conflict: DiskVersion | null = null;
    saving = false;
    saveError = '';

    constructor(readonly path: string) {
        makeAutoObservable(this, { path: false });
    }

    /** The text has changes that exist nowhere else. */
    get edited(): boolean {
        return this.text !== this.savedText;
    }

    /** There is something to save: edited text, or a file that must be created again. */
    get dirty(): boolean {
        return this.edited || this.removed;
    }

    loaded(file: DocFile): void {
        this.status = 'ready';
        this.error = '';
        this.text = file.content;
        this.savedText = file.content;
        this.baseHash = file.hash;
        this.removed = false;
        this.conflict = null;
    }

    failed(message: string): void {
        this.status = 'failed';
        this.error = message;
    }

    edit(text: string): void {
        if (this.status === 'ready') this.text = text;
    }

    /** What a fresh look at the disk found: the file's version, or `null` when there is no such file. */
    observe(disk: DiskVersion | null): void {
        if (this.status !== 'ready') return;

        if (disk === null) {
            this.removed = true;
            this.baseHash = null;
            this.conflict = null;
        }
        else if (disk.content === this.savedText) {
            // Nothing changed on disk since the base, or it came back as it was: only the base's hash moves.
            this.rebase(disk);
        }
        else if (disk.content === this.text || !this.edited) {
            this.text = disk.content;
            this.rebase(disk);
        }
        else {
            this.conflict = disk;
        }
    }

    startSave(): { content: string; baseHash: string | null } {
        this.saving = true;
        this.saveError = '';

        return { content: this.text, baseHash: this.baseHash };
    }

    /** The disk took `content`, which is now the version `hash`. Text typed while the save was under way stays edited. */
    finishSave(content: string, hash: string): void {
        this.saving = false;
        this.rebase({ content, hash });
    }

    failSave(message: string): void {
        this.saving = false;
        this.saveError = message;
    }

    /** The save met another version on disk. */
    conflictedSave(disk: DiskVersion | null): void {
        this.saving = false;
        this.observe(disk);
    }

    /** Ends a save whose outcome is not known; the owner looks at the disk next. */
    endSave(): void {
        this.saving = false;
    }

    /** Drops the edits for the disk's version, `theirs`, which is the one the person was shown. */
    takeTheirs(theirs: DiskVersion): void {
        if (this.conflict?.hash !== theirs.hash) return;

        this.text = theirs.content;
        this.rebase(theirs);
    }

    private rebase(disk: DiskVersion): void {
        this.savedText = disk.content;
        this.baseHash = disk.hash;
        this.removed = false;
        this.conflict = null;
    }
}
