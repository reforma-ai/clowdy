import { action, runInAction } from 'mobx';

import { basename, dirname, isPathWithin, joinPath, normalizePath } from './paths';
import { FileSystemError } from './provider';

import type { TextDocument } from './documents/TextDocument';
import type { FileManager } from './FileManager';
import type { ClipboardEntry, FileChange, FileKind, MoveOperation } from './provider';
import type { FileTree } from './tree/FileTree';

/** A file, or a folder (`file: null`), from outside the project; `path` is relative to the folder it goes in. */
export interface UploadItem {
    path: string;
    file: Blob | null;
}

export interface MoveOptions {
    /** Asked with the names that already exist in the target folder; resolve `true` to replace them. Without it, the move stops. */
    confirmReplace?: (names: string[]) => Promise<boolean> | boolean;
}

/** Paths without the root, duplicates, and paths inside another one of them. */
export function topmost(paths: readonly string[]): string[] {
    const sorted = [...new Set(paths.map(normalizePath))].filter(path => path !== '').sort();

    return sorted.filter((path, index) => !sorted.slice(0, index).some(other => isPathWithin(path, other)));
}

/** `page.tsx` → `page copy.tsx`, then `page copy 2.tsx`; folders and dotfiles have no extension to keep. */
function copyName(name: string, kind: FileKind, taken: (name: string) => boolean): string {
    const dot = kind === 'file' ? name.lastIndexOf('.') : -1;
    const extension = dot > 0 ? name.slice(dot) : '';
    // A copy of a copy counts on from the original name.
    const stem = (dot > 0 ? name.slice(0, dot) : name).replace(/ copy(?: \d+)?$/, '');

    for (let count = 1; ; count++) {
        const candidate = `${stem} copy${count > 1 ? ` ${count}` : ''}${extension}`;

        if (!taken(candidate)) {
            return candidate;
        }
    }
}

/**
 * Which names in `folder` are taken: the ones the tree lists, and the ones `claim` is given for the items being made. A name that differs only in case is taken
 * too, as the disks the app runs on (APFS, NTFS) see it, so a paste does not meet a refusal for `readme.md` beside `README.md`.
 */
function takenNames(tree: FileTree, folder: string): { taken: (name: string) => boolean; claim: (name: string) => void } {
    const used = new Set<string>();

    for (const path of tree.entries.keys()) {
        if (dirname(path) === folder) {
            used.add(basename(path).toLowerCase());
        }
    }

    return { taken: name => used.has(name.toLowerCase()), claim: name => void used.add(name.toLowerCase()) };
}

/** Tree changes that move or copy `from` and everything inside it to `to`, replacing `to`. None when `from` is not listed. */
function transferChanges(tree: FileTree, from: string, to: string, copy: boolean): FileChange[] {
    const moved = [...tree.entries.values()].filter(entry => isPathWithin(entry.path, from));

    if (moved.length === 0) {
        return [];
    }

    const changes: FileChange[] = [{ type: 'deleted', path: to }];

    if (!copy) {
        changes.push({ type: 'deleted', path: from });
    }

    for (const entry of moved) {
        changes.push({ type: 'created', path: to + entry.path.slice(from.length), kind: entry.kind, size: entry.size });
    }

    return changes;
}

function describe(paths: readonly string[]): string {
    return paths.length === 1 ? paths[0]! : `${paths.length} items`;
}

/**
 * Creates, renames, moves, copies and deletes. Each action is one provider call, so a provider
 * that journals its calls (the sandbox's undo history) records one step per action. The tree and
 * open tabs change right away; the provider's watch events for the action then change nothing.
 */
export class FileOperations {
    readonly #manager: FileManager;

    constructor(manager: FileManager) {
        this.#manager = manager;
    }

    /**
     * Why `name` can't be used in the folder `parent`, or `null` when it can. The name may hold new
     * folders (`ui/button.tsx`). When renaming, `current` is the path being renamed.
     */
    validateName(parent: string, name: string, current?: string): string | null {
        const trimmed = name.trim();
        const segments = trimmed.split('/');

        if (trimmed === '') {
            return 'Enter a name';
        }

        if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
            return `“${trimmed}” isn’t a valid name`;
        }

        const { tree } = this.#manager;
        const path = joinPath(parent, trimmed);

        for (let index = 1; index < segments.length; index++) {
            if (tree.get(joinPath(parent, segments.slice(0, index).join('/')))?.kind === 'file') {
                return `“${segments[index - 1]}” is a file`;
            }
        }

        if (current !== undefined && path !== current && isPathWithin(path, current)) {
            return `“${basename(current)}” can’t go inside itself`;
        }

        if (path !== current && tree.get(path)) {
            return `“${trimmed}” already exists`;
        }

        return null;
    }

    /** Creates an empty file; `name` may hold new folders. Resolves its path, or `null` when it was not created. */
    async createFile(parent: string, name: string): Promise<string | null> {
        const path = this.#newPath(parent, name);

        if (path === null) {
            return null;
        }

        const created = await this.#run(
            [{ type: 'created', path, kind: 'file', size: 0 }],
            () => this.#manager.provider.write(path, '', { expectedVersion: null }),
            `Couldn’t create ${path}`
        );

        return created ? path : null;
    }

    /** Creates a folder; `name` may hold new folders. Resolves its path, or `null` when it was not created. */
    async createDirectory(parent: string, name: string): Promise<string | null> {
        const path = this.#newPath(parent, name);

        if (path === null) {
            return null;
        }

        const created = await this.#run(
            [{ type: 'created', path, kind: 'directory' }],
            () => this.#manager.provider.createDirectory(path),
            `Couldn’t create ${path}`
        );

        return created ? path : null;
    }

    /** Renames a file or folder; `name` may hold new folders. Resolves the new path, or `null` when nothing moved. */
    async rename(path: string, name: string): Promise<string | null> {
        const source = normalizePath(path);
        const target = this.#newPath(dirname(source), name, source);

        if (target === null || target === source) {
            return null;
        }

        return (await this.#transfer([{ from: source, to: target }], false, `Couldn’t rename ${source}`))
            ? target
            : null;
    }

    /**
     * Moves files and folders into the folder `target`. Names that already exist there go through
     * `confirmReplace`. Resolves `true` when the items moved.
     */
    async move(paths: readonly string[], target: string, { confirmReplace }: MoveOptions = {}): Promise<boolean> {
        const folder = normalizePath(target);
        const sources = topmost(paths).filter(path => dirname(path) !== folder);
        const moves = sources.map(from => ({ from, to: joinPath(folder, basename(from)) }));

        if (moves.length === 0) {
            return false;
        }

        if (sources.some(path => isPathWithin(folder, path))) {
            this.#manager.notify('A folder can’t move into itself');

            return false;
        }

        if (new Set(moves.map(move => move.to)).size < moves.length) {
            this.#manager.notify('Items with the same name can’t move into one folder');

            return false;
        }

        const taken = moves.filter(move => this.#manager.tree.get(move.to)).map(move => basename(move.to));

        if (taken.length > 0 && !(await confirmReplace?.(taken))) {
            return false;
        }

        return this.#transfer(moves, taken.length > 0, `Couldn’t move ${describe(sources)}`, confirmReplace);
    }

    /**
     * Copies files and folders into the folder `target`, keeping their names; a name already taken
     * there gets “ copy”, then “ copy 2”. Paths the tree no longer lists are skipped. Resolves
     * the copies' paths, none when nothing was copied.
     */
    async copy(paths: readonly string[], target: string): Promise<string[]> {
        const folder = normalizePath(target);
        const { tree, provider } = this.#manager;
        const requested = topmost(paths);

        if (requested.length === 0) {
            return [];
        }

        try {
            // The names taken in a folder are known once it is listed.
            await tree.load(folder);
        }
        catch (error) {
            this.#manager.notify('Couldn’t list the folder', error);

            return [];
        }

        // Read after the listing: a watch event may have taken a source away meanwhile.
        const sources = requested.filter(path => tree.get(path));

        if (sources.length === 0) {
            this.#manager.notify('The copied items no longer exist');

            return [];
        }

        if (sources.some(path => isPathWithin(folder, path))) {
            this.#manager.notify('A folder can’t be copied into itself');

            return [];
        }

        const { taken, claim } = takenNames(tree, folder);
        const copies = sources.map(from => {
            const name = basename(from);
            const free = taken(name) ? copyName(name, tree.get(from)!.kind, taken) : name;

            claim(free);

            return { from, to: joinPath(folder, free) };
        });
        const copied = await this.#run(
            copies.flatMap(({ from, to }) => transferChanges(tree, from, to, true)),
            () => provider.copy(copies),
            `Couldn’t copy ${describe(sources)}`
        );

        return copied ? copies.map(copy => copy.to) : [];
    }

    /**
     * Writes files and folders from outside the project, e.g. dropped from the desktop, into the
     * folder `target`. Each folder comes before what it holds. A top-level name already taken there
     * gets “ copy”, as with `copy`. Each file is its own provider call. Resolves the top-level
     * paths, none when the upload failed.
     */
    async upload(items: readonly UploadItem[], target: string): Promise<string[]> {
        const folder = normalizePath(target);
        const { tree, provider } = this.#manager;

        if (items.length === 0 || this.#manager.readonly) {
            return [];
        }

        try {
            await tree.load(folder);
        }
        catch (error) {
            this.#manager.notify('Couldn’t list the folder', error);

            return [];
        }

        const names = new Map<string, string>();
        const { taken, claim } = takenNames(tree, folder);

        for (const { path, file } of items.filter(item => !item.path.includes('/'))) {
            const free = taken(path) ? copyName(path, file ? 'file' : 'directory', taken) : path;

            names.set(path, free);
            claim(free);
        }

        const writes = items.map(({ path, file }) => {
            const [top = '', ...rest] = path.split('/');

            return { path: joinPath(folder, [names.get(top) ?? top, ...rest].join('/')), file };
        });
        // A file write creates its folders; only empty ones need their own call.
        const parents = new Set(writes.map(item => dirname(item.path)));
        const uploads = [...names.values()].map(name => joinPath(folder, name));
        const uploaded = await this.#run(
            writes.map(({ path, file }) =>
                file
                    ? { type: 'created', path, kind: 'file', size: file.size }
                    : { type: 'created', path, kind: 'directory' }
            ),
            async () => {
                for (const { path, file } of writes) {
                    if (file) {
                        await provider.write(path, file, { expectedVersion: null });
                    }
                    else if (!parents.has(path)) {
                        await provider.createDirectory(path);
                    }
                }
            },
            `Couldn’t upload ${describe(uploads)}`
        );

        return uploaded ? uploads : [];
    }

    /**
     * Copies files and folders the host's clipboard names, from outside the provider (copied in the host's file manager, or inside the root where the tree has not
     * listed them), into the folder `target`: the host makes the copies on its disk. A top-level name already taken there gets “ copy”, as with `copy`. The tree shows
     * the copies at once, a folder's contents when it is opened. Resolves the copies' paths, none when the paste failed.
     */
    async import(entries: readonly ClipboardEntry[], target: string): Promise<string[]> {
        const { clipboard, tree } = this.#manager;

        if (!clipboard || entries.length === 0 || this.#manager.readonly) {
            return [];
        }

        const folder = normalizePath(target);

        try {
            await tree.load(folder);
        }
        catch (error) {
            this.#manager.notify('Couldn’t list the folder', error);

            return [];
        }

        const { taken, claim } = takenNames(tree, folder);
        const copies = entries.map((entry) => {
            const name = taken(entry.name) ? copyName(entry.name, entry.kind, taken) : entry.name;

            claim(name);

            return { entry, name, path: joinPath(folder, name) };
        });
        const pasted = await this.#run(
            copies.map(({ entry, path }) => ({ type: 'created', path, kind: entry.kind })),
            () => clipboard.paste(folder, copies.map(({ entry, name }) => ({ path: entry.path, name }))),
            `Couldn’t paste ${describe(copies.map(copy => copy.path))}`
        );

        if (!pasted) {
            return [];
        }

        // A pasted folder is shown empty until it is listed: the host's copy is done, so its contents are there to list.
        for (const { entry, path } of copies) {
            if (entry.kind === 'directory') {
                tree.load(path).catch(() => undefined);
            }
        }

        return copies.map(copy => copy.path);
    }

    /** Deletes files and folders; tabs inside them close unless they hold unsaved edits. Resolves `true` when they are gone. */
    async delete(paths: readonly string[]): Promise<boolean> {
        const targets = topmost(paths);

        if (targets.length === 0) {
            return false;
        }

        const deleted = await this.#run(
            targets.map(path => ({ type: 'deleted', path })),
            () => this.#manager.provider.delete(targets),
            `Couldn’t delete ${describe(targets)}`
        );

        if (deleted) {
            for (const document of this.#manager.tabs.documents.filter(open =>
                targets.some(path => isPathWithin(open.path, path))
            )) {
                this.#manager.reconcile(document);
            }
        }

        return deleted;
    }

    /**
     * Follows moves already made, in order, e.g. by an app undo: the tree and open tabs move with
     * them, and a tab on a replaced file reloads or shows "Changed on disk". The provider's watch
     * events for the moves then change nothing.
     */
    @action
    applyMoves(moves: readonly MoveOperation[]): void {
        const normalized = moves
            .map(({ from, to }) => ({ from: normalizePath(from), to: normalizePath(to) }))
            .filter(({ from, to }) => from !== '' && from !== to);

        for (const document of this.#follow(normalized)) {
            this.#manager.reconcile(document);
        }
    }

    /** The path for a new name in `parent`, or `null` with the reason reported. */
    #newPath(parent: string, name: string, current?: string): string | null {
        const problem = this.validateName(parent, name, current);

        if (problem) {
            this.#manager.notify(problem);

            return null;
        }

        return joinPath(parent, name.trim());
    }

    /** Lists the tree again after a failed call, which the patch got ahead of. */
    #relist(): void {
        this.#manager.tree.refresh().catch((error: unknown) => {
            this.#manager.notify('Couldn’t list files', error);
        });
    }

    /** Patches the tree, then makes the provider call. A failure is reported and the tree listed again. */
    async #run(changes: readonly FileChange[], request: () => Promise<unknown>, failure: string): Promise<boolean> {
        if (this.#manager.readonly) {
            return false;
        }

        this.#manager.tree.applyChanges(changes);

        try {
            await request();

            return true;
        }
        catch (error) {
            this.#manager.notify(failure, error);
            this.#relist();

            return false;
        }
    }

    /** Moves in one provider call. A target the tree did not know about goes through `confirmReplace`, then the move runs once more. */
    async #transfer(
        moves: MoveOperation[],
        overwrite: boolean,
        failure: string,
        confirmReplace?: MoveOptions['confirmReplace']
    ): Promise<boolean> {
        if (this.#manager.readonly) {
            return false;
        }

        const { tree, tabs } = this.#manager;
        const paths = new Map(tabs.documents.map(document => [document, document.path]));
        const stale = this.#follow(moves);

        try {
            await this.#manager.provider.move(moves, { overwrite });
        }
        catch (error) {
            runInAction(() => {
                for (const { from, to } of [...moves].reverse()) {
                    tree.applyChanges(transferChanges(tree, to, from, false));
                }

                for (const document of tabs.documents) {
                    const path = paths.get(document);

                    if (path !== undefined && path !== document.path) {
                        tabs.retarget(document, path);
                    }
                }
            });
            this.#relist();

            if (!overwrite && confirmReplace && FileSystemError.is(error, 'Exists')) {
                const names = error.path ? [basename(error.path)] : moves.map(move => basename(move.to));

                return (await confirmReplace(names)) && this.#transfer(moves, true, failure);
            }

            this.#manager.notify(failure, error);

            return false;
        }

        for (const document of stale) {
            this.#manager.reconcile(document);
        }

        return true;
    }

    /**
     * Moves the tree and open tabs with normalized moves. A moved tab takes the place of a clean tab
     * on its new path; a tab there with unsaved edits stays, and the moved tab stays behind instead.
     * Returns the tabs whose file the moves replaced or took away, to check once the moves are on disk.
     */
    @action
    #follow(moves: readonly MoveOperation[]): TextDocument[] {
        const { tree, tabs } = this.#manager;
        const stale: TextDocument[] = [];

        for (const { from, to } of moves) {
            const replaced = tabs.documents.filter(open => isPathWithin(open.path, to));

            tree.applyChanges(transferChanges(tree, from, to, false));

            for (const document of tabs.documents.filter(open => isPathWithin(open.path, from))) {
                const path = to + document.path.slice(from.length);
                const occupant = replaced.find(open => open.path === path);

                if (occupant?.dirty) {
                    stale.push(document);

                    continue;
                }

                if (occupant) {
                    replaced.splice(replaced.indexOf(occupant), 1);
                    this.#manager.close(path);
                }

                tabs.retarget(document, path);
            }

            stale.push(...replaced);
        }

        return stale;
    }
}
