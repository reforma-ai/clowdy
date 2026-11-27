import { type ComposerDoc, emptyComposerDoc } from '@clowdy/components/RichInput';
import { makeAutoObservable, observableRef } from 'mobx';

import { samePath } from '../features/agents/workspaceChoice';
import { browserStorage, type KeyValueStorage, readStored, writeStored } from './storage';

import type { ChatWorkspaceChoice, FolderId, ProjectId } from '@clowdy/protocol';

export interface NewChatDraft {
    readonly id: string;
    readonly folderId: FolderId | null;
    readonly workspace: ChatWorkspaceChoice | null;
    readonly doc: ComposerDoc;
}

function sameWorkspace(a: ChatWorkspaceChoice | null, b: ChatWorkspaceChoice | null): boolean {
    if (!a || !b) return a === b;
    if (a.mode !== b.mode) return false;
    if (a.mode === 'existing' && b.mode === 'existing') return samePath(a.path, b.path);
    if (a.mode === 'main' && b.mode === 'main') return a.branch === b.branch;
    if (a.mode === 'new' && b.mode === 'new')
        return a.base === b.base && a.branchPrefix === b.branchPrefix && a.branchName === b.branchName;
    return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWorkspace(value: unknown): value is ChatWorkspaceChoice | null {
    if (value === null) return true;
    if (!isObject(value)) return false;
    if (value.mode === 'existing') return typeof value.path === 'string';
    if (value.mode === 'main') return typeof value.branch === 'string';
    return (
        value.mode === 'new' &&
        (value.base === undefined || typeof value.base === 'string') &&
        (value.branchPrefix === undefined || typeof value.branchPrefix === 'string') &&
        (value.branchName === undefined || typeof value.branchName === 'string')
    );
}

function isNode(value: unknown): value is ComposerDoc {
    const pending = [value];
    while (pending.length) {
        const node = pending.pop();
        if (!isObject(node) || typeof node.type !== 'string') return false;
        if (node.text !== undefined && typeof node.text !== 'string') return false;
        if (node.attrs !== undefined && !isObject(node.attrs)) return false;
        if (node.marks !== undefined && (!Array.isArray(node.marks) || !node.marks.every(isMark))) return false;
        if (node.content !== undefined) {
            if (!Array.isArray(node.content)) return false;
            pending.push(...node.content);
        }
    }
    return true;
}

function isMark(value: unknown): boolean {
    return isObject(value) && typeof value.type === 'string' && (value.attrs === undefined || isObject(value.attrs));
}

function nonempty(doc: ComposerDoc): boolean {
    const pending = [doc];
    while (pending.length) {
        const node = pending.pop()!;
        if (node.type === 'composerMention' || (node.type === 'text' && node.text?.trim())) return true;
        if (node.content) pending.push(...node.content);
    }
    return false;
}

function restore(value: unknown): NewChatDraft[] {
    if (!Array.isArray(value)) return [];
    const ids = new Set<string>();
    return value
        .filter((item): item is NewChatDraft => {
            if (
                !isObject(item) ||
                typeof item.id !== 'string' ||
                !item.id ||
                ids.has(item.id) ||
                (item.folderId !== null && typeof item.folderId !== 'string') ||
                !isWorkspace(item.workspace) ||
                !isNode(item.doc) ||
                item.doc.type !== 'doc' ||
                !nonempty(item.doc)
            )
                return false;
            ids.add(item.id);
            return true;
        })
        .map(({ id, folderId, workspace, doc }) => ({ id, folderId, workspace, doc }));
}

export class NewChatDrafts {
    drafts: readonly NewChatDraft[];
    readonly #storage: KeyValueStorage | undefined;
    readonly #key: string;

    constructor(projectId: ProjectId, storage: KeyValueStorage | undefined = browserStorage()) {
        this.#storage = storage;
        this.#key = `new-chat-drafts:${projectId}`;
        this.drafts = restore(readStored(storage, this.#key));
        makeAutoObservable(this, { drafts: observableRef });
    }

    createOrOpen(folderId: FolderId | null, workspace: ChatWorkspaceChoice | null): NewChatDraft {
        const existing = this.drafts.find(
            draft => draft.folderId === folderId && sameWorkspace(draft.workspace, workspace)
        );
        if (existing) return existing;
        const draft: NewChatDraft = { id: crypto.randomUUID(), folderId, workspace, doc: emptyComposerDoc() };
        this.drafts = [...this.drafts, draft];
        this.persist();
        return draft;
    }

    get(id: string): NewChatDraft | undefined {
        return this.drafts.find(draft => draft.id === id);
    }

    updatePlace(id: string, folderId: FolderId | null, workspace: ChatWorkspaceChoice | null): void {
        this.drafts = this.drafts.map(draft => (draft.id === id ? { ...draft, folderId, workspace } : draft));
        this.persist();
    }

    updateDoc(id: string, doc: ComposerDoc): void {
        this.drafts = this.drafts.map(draft => (draft.id === id ? { ...draft, doc } : draft));
        this.persist();
    }

    remove(id: string): void {
        this.drafts = this.drafts.filter(draft => draft.id !== id);
        this.persist();
    }

    private persist(): void {
        writeStored(
            this.#storage,
            this.#key,
            this.drafts.filter(draft => nonempty(draft.doc))
        );
    }
}
