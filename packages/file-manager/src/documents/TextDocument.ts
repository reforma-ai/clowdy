import { Compartment, EditorSelection, EditorState, Text } from '@codemirror/state';
import { action, computed, observable, observableRef, runInAction } from 'mobx';

import { extname, isRichMarkdown, mediaKind } from '../paths';
import { FileSystemError } from '../provider';

import type { ChangeSpec, Extension, Transaction, TransactionSpec } from '@codemirror/state';
import type { FileManager } from '../FileManager';
import type { FileContent } from '../provider';

/** Text files larger than this open as a "too large" note instead of in the editor. */
const MAX_TEXT_SIZE = 5 * 1024 * 1024;
/** Images, video, audio and PDFs open in a preview up to this size. */
const MAX_MEDIA_SIZE = 50 * 1024 * 1024;

/** Bytes a file may have to open: a preview for media, the editor for everything else. */
export function sizeLimit(path: string): number {
    return mediaKind(path) ? MAX_MEDIA_SIZE : MAX_TEXT_SIZE;
}

export type DocumentStatus = 'loading' | 'text' | 'binary' | 'tooLarge' | 'error';

/** How a text file shows: as text in the code editor, as rich text (markdown), or as an image (SVG). */
export type DocumentView = 'source' | 'rich' | 'preview';

/** A 1-based position. Columns count UTF-16 code units. */
export interface TextPosition {
    line: number;
    column: number;
}

/** A cursor (`from` only) or a range. */
export interface TextSelection {
    from: TextPosition;
    to?: TextPosition;
}

/** Whatever shows a document and applies its transactions; a CodeMirror `EditorView` fits. */
export interface DocumentEditor {
    dispatch(transaction: Transaction): void;
}

/** Holds the extensions a view supplies (keymaps, language, theme), so they stay out of the core. */
const viewExtensions = new Compartment();

function offsetOf(doc: Text, { line, column }: TextPosition): number {
    const target = doc.line(Math.min(Math.max(1, line), doc.lines));

    return target.from + Math.min(Math.max(1, column), target.length + 1) - 1;
}

function positionOf(doc: Text, offset: number): TextPosition {
    const line = doc.lineAt(offset);

    return { line: line.number, column: offset - line.from + 1 };
}

/** The smallest single replacement that turns `current` into `next`, so the cursor and scroll stay put. */
function changeBetween(current: string, next: string): ChangeSpec | null {
    if (current === next) {
        return null;
    }

    const shorter = Math.min(current.length, next.length);
    let start = 0;

    while (start < shorter && current.charCodeAt(start) === next.charCodeAt(start)) {
        start++;
    }

    let end = 0;

    while (
        end < shorter - start &&
        current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)
    ) {
        end++;
    }

    return { from: start, to: current.length - end, insert: next.slice(start, next.length - end) };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * One open file. Text lives in a CodeMirror `EditorState` owned here, so undo history, selection
 * and unsaved edits survive the view unmounting. Loads, saves and disk changes run one at a time.
 */
export class TextDocument {
    /** Follows renames and moves; see `Tabs.retarget`. */
    @observable accessor path: string;
    @observable accessor status: DocumentStatus = 'loading';
    /** Text, selection and undo history; set while `status` is `text`. */
    @observableRef accessor state: EditorState | null = null;
    /** File contents while `status` is `binary`. */
    @observableRef accessor blob: Blob | null = null;
    /** Why the file could not be opened, while `status` is `error`. */
    @observable accessor error: string | null = null;
    /** The file changed on disk under unsaved edits. Resolve with `reload` or `overwrite`. */
    @observable accessor conflict = false;
    /** The file was deleted on disk under unsaved edits. Saving creates it again. */
    @observable accessor deleted = false;

    @observableRef private accessor savedDoc: Text = Text.empty;
    @observable private accessor showSource = false;
    @observable private accessor blockedReason: string | null = null;

    readonly #manager: FileManager;
    /** Version the buffer was loaded from or saved as; `null` when no file is on disk. */
    #version: string | null = null;
    /** Version on disk during a conflict: `null` when the file is gone, `undefined` when unknown. */
    #diskVersion: string | null | undefined;
    /** Line break of the file on disk; the buffer always uses `\n`. */
    #lineBreak = '\n';
    #editor: DocumentEditor | null = null;
    #queue: Promise<unknown> = Promise.resolve();
    #disposed = false;

    constructor(path: string, manager: FileManager) {
        this.path = path;
        this.#manager = manager;
    }

    /** The view a file has besides source: rich text for markdown, a preview for SVG; `null` for other files. */
    @computed
    get renderedView(): Exclude<DocumentView, 'source'> | null {
        if (isRichMarkdown(this.path)) {
            return 'rich';
        }

        return extname(this.path) === 'svg' ? 'preview' : null;
    }

    /** The rendered view until switched to source; source for a file without one. */
    @computed
    get view(): DocumentView {
        return this.showSource ? 'source' : (this.renderedView ?? 'source');
    }

    /** Why rich text refused this markdown file, which then shows as source. Switching to rich again clears it. */
    @computed
    get richTextBlocked(): string | null {
        return isRichMarkdown(this.path) ? this.blockedReason : null;
    }

    /** The buffer differs from the file on disk. */
    @computed
    get dirty(): boolean {
        return this.status === 'text' && this.state !== null && (this.deleted || !this.state.doc.eq(this.savedDoc));
    }

    /** The main selection, 1-based, with `to` only for a non-empty range. `null` without text. */
    get selection(): TextSelection | null {
        if (this.status !== 'text' || !this.state) {
            return null;
        }

        const { doc } = this.state;
        const { from, to } = this.state.selection.main;

        return from === to ? { from: positionOf(doc, from) } : { from: positionOf(doc, from), to: positionOf(doc, to) };
    }

    /** Resolves once queued loads, saves and disk changes have finished. */
    async idle(): Promise<void> {
        await this.#queue.catch(() => undefined);
    }

    load(): Promise<void> {
        return this.#enqueue(() => this.#load());
    }

    /**
     * Saves the buffer: save participants, a final newline, then a write over the version the
     * buffer was loaded from. A newer version on disk puts the document in `conflict`.
     * Resolves `true` when nothing is left unsaved.
     */
    save(): Promise<boolean> {
        return this.#enqueue(() => this.#save(this.#version, false));
    }

    /** Saves the buffer over whatever is on disk now, resolving a conflict in favor of the buffer. */
    overwrite(): Promise<boolean> {
        return this.#enqueue(() => this.#save(this.#diskVersion, true));
    }

    /** Discards the buffer and loads the file from disk again. */
    reload(): Promise<void> {
        return this.#enqueue(async () => {
            try {
                const content = await this.#manager.provider.read(this.path);

                if (!this.#disposed) {
                    this.#show(content);
                }
            } catch (error) {
                if (FileSystemError.is(error, 'NotFound')) {
                    this.#markDeleted();

                    return;
                }

                this.#manager.notify(`Couldn’t reload ${this.path}`, error);
            }
        });
    }

    /**
     * Moves the selection to a 1-based range and scrolls it into view, switching to source so the
     * range shows. Lines and columns past the end clamp.
     */
    @action
    select(selection: TextSelection): void {
        if (!this.state) {
            return;
        }

        const { doc } = this.state;
        const anchor = offsetOf(doc, selection.from);
        const head = selection.to ? offsetOf(doc, selection.to) : anchor;

        this.showSource = true;
        this.dispatch({ selection: EditorSelection.single(anchor, head), scrollIntoView: true });
    }

    /** Shows the file as source or in its rendered view. Switching clears `richTextBlocked`, so rich text checks the file again. */
    @action
    setView(view: DocumentView): void {
        this.showSource = view === 'source';
        this.blockedReason = null;
    }

    /** Shows the file as source because rich text would lose part of it, for the reason given. */
    @action
    blockRichText(reason: string): void {
        this.showSource = true;
        this.blockedReason = reason;
    }

    /** Replaces the text through the smallest single change, as an edit; the cursor and scroll stay put. */
    replaceText(text: string): void {
        const change = this.state && changeBetween(this.state.doc.toString(), text);

        if (change) {
            this.dispatch({ changes: change });
        }
    }

    /** Applies a change to the text; through the attached editor when one shows this document. */
    @action
    dispatch(...specs: TransactionSpec[]): void {
        if (!this.state) {
            return;
        }

        const transaction = this.state.update(...specs);

        if (this.#editor) {
            this.#editor.dispatch(transaction);
        } else {
            this.state = transaction.state;
        }
    }

    /** Sets the view's extensions in this document's state. */
    configure(extension: Extension): void {
        this.dispatch({ effects: viewExtensions.reconfigure(extension) });
    }

    /** Routes changes through `editor`, which must already show `state` and report back with `setState`. */
    attach(editor: DocumentEditor): void {
        this.#editor = editor;
    }

    detach(editor: DocumentEditor): void {
        if (this.#editor === editor) {
            this.#editor = null;
        }
    }

    /** Called by the attached editor after it applies transactions. */
    @action
    setState(state: EditorState): void {
        this.state = state;
    }

    /**
     * @internal A change on disk; `version` is undefined when the provider did not report one.
     * Resolves `true` when the file turned out to be gone and the buffer was clean, so the tab can close.
     */
    handleChange(version?: string): Promise<boolean> {
        return this.#enqueue(async () => {
            if (this.#disposed || (version !== undefined && version === this.#version)) {
                return false;
            }

            if (this.status !== 'text') {
                await this.#load();

                return false;
            }

            if (this.dirty && version !== undefined) {
                this.#markConflict(version);

                return false;
            }

            let content: FileContent;

            try {
                content = await this.#manager.provider.read(this.path);
            } catch (error) {
                // Gone with no delete event, e.g. one a resync makes up for. Other failures wait for the next change.
                return FileSystemError.is(error, 'NotFound') && this.#gone();
            }

            // Same version: the echo of a save.
            if (this.#disposed || content.version === this.#version) {
                return false;
            }

            if (this.dirty) {
                this.#markConflict(content.version);
            } else {
                this.#show(content);
            }

            return false;
        });
    }

    /** @internal The file is gone from disk. Resolves `true` when the buffer was clean, so the tab can close. */
    handleDelete(): Promise<boolean> {
        return this.#enqueue(() => this.#gone());
    }

    dispose(): void {
        this.#disposed = true;
        this.#editor = null;
    }

    #enqueue<T>(task: () => Promise<T> | T): Promise<T> {
        const run = this.#queue.catch(() => undefined).then(task);

        this.#queue = run;

        return run;
    }

    async #load(): Promise<void> {
        const size = this.#manager.tree.get(this.path)?.size;

        if (size !== undefined && size > sizeLimit(this.path)) {
            runInAction(() => {
                this.status = 'tooLarge';
            });

            return;
        }

        try {
            const content = await this.#manager.provider.read(this.path);

            if (!this.#disposed) {
                this.#show(content);
            }
        } catch (error) {
            runInAction(() => {
                this.status = 'error';
                this.error = messageOf(error);
            });
        }
    }

    /** Shows what is on disk: a text buffer (reloaded in place when it already exists), a blob or a note. */
    @action
    #show(content: FileContent): void {
        this.#version = content.version;
        this.#diskVersion = undefined;
        this.conflict = false;
        this.deleted = false;
        this.error = null;
        this.blob = content.kind === 'binary' ? content.blob : null;

        if (content.kind === 'binary' || content.text.length > MAX_TEXT_SIZE) {
            this.status = content.kind === 'binary' ? 'binary' : 'tooLarge';
            this.state = null;

            return;
        }

        this.#lineBreak = content.text.includes('\r\n') ? '\r\n' : '\n';
        const text = this.#lineBreak === '\n' ? content.text : content.text.replaceAll('\r\n', '\n');

        if (this.status === 'text' && this.state) {
            this.replaceText(text);
        } else {
            this.state = EditorState.create({
                doc: text,
                extensions: [viewExtensions.of([]), EditorState.readOnly.of(this.#manager.readonly)],
            });
        }

        this.savedDoc = this.state!.doc;
        this.status = 'text';
    }

    async #save(expectedVersion: string | null | undefined, force: boolean): Promise<boolean> {
        if (this.#disposed || this.status !== 'text' || !this.state || (!force && !this.dirty)) {
            return !this.dirty;
        }

        if (this.#manager.readonly) {
            return false;
        }

        const before = this.state.doc;
        let text = before.toString();

        for (const participant of this.#manager.saveParticipants) {
            try {
                text = (await participant(this.path, text))?.replace(/\r\n?/g, '\n') ?? text;
            } catch (error) {
                this.#manager.notify(`Couldn’t run a save step for ${this.path}`, error);
            }
        }

        if (this.#disposed) {
            return false;
        }

        if (text !== '' && !text.endsWith('\n')) {
            text += '\n';
        }

        // Show what gets written, unless the person typed while the participants ran.
        let written = Text.of(text.split('\n'));

        if (this.state.doc === before) {
            this.replaceText(text);
            written = this.state.doc;
        }

        try {
            const disk = this.#lineBreak === '\n' ? text : text.replaceAll('\n', this.#lineBreak);
            const version = await this.#manager.provider.write(this.path, disk, { expectedVersion });

            runInAction(() => {
                this.#version = version;
                this.#diskVersion = undefined;
                this.savedDoc = written;
                this.conflict = false;
                this.deleted = false;
            });

            return true;
        } catch (error) {
            if (FileSystemError.is(error, 'Conflict') || FileSystemError.is(error, 'Exists')) {
                this.#markConflict(error.currentVersion);
            } else if (FileSystemError.is(error, 'NotFound')) {
                this.#markConflict(null);
            } else {
                this.#manager.notify(`Couldn’t save ${this.path}`, error);
            }

            return false;
        }
    }

    @action
    #markConflict(diskVersion: string | null | undefined): void {
        this.conflict = true;
        this.deleted = false;
        this.#diskVersion = diskVersion;
    }

    /** A dirty buffer is marked deleted; returns `true` when it was clean. */
    #gone(): boolean {
        if (!this.dirty) {
            return true;
        }

        this.#markDeleted();

        return false;
    }

    @action
    #markDeleted(): void {
        this.deleted = true;
        this.conflict = false;
        this.#version = null;
        this.#diskVersion = undefined;
    }
}
