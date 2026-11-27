import { type ComposerDoc, emptyComposerDoc } from '@clowdy/components/RichInput';
import { commandSchema } from '@clowdy/protocol';
import { makeAutoObservable, observableRef } from 'mobx';

import { samePath } from '../features/agents/workspaceChoice';
import { browserStorage, type KeyValueStorage, readStored, writeStored } from './storage';

import type { Attachment, Chat, ChatWorkspaceChoice, Command, FolderId, ProjectId } from '@clowdy/protocol';
import type { ReplyMessage } from '../stream/MessageActions';

export interface NewChatDraft {
    readonly id: string;
    readonly folderId: FolderId | null;
    readonly workspace: ChatWorkspaceChoice | null;
    readonly doc: ComposerDoc;
    readonly createdChat?: Chat;
    readonly firstMessage?: Omit<Extract<Command, { type: 'chat.send' }>, 'type' | 'requestId' | 'chatId'>;
    readonly operation?: Extract<Command, { type: 'chat.create' | 'chat.send' }>;
    readonly attachments?: readonly Attachment[];
    readonly reply?: ReplyMessage;
    readonly engine?: string;
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
                (!nonempty(item.doc) &&
                    item.operation === undefined &&
                    item.firstMessage === undefined &&
                    item.reply === undefined &&
                    (!Array.isArray(item.attachments) || item.attachments.length === 0)) ||
                (item.createdChat !== undefined &&
                    (!isObject(item.createdChat) || typeof item.createdChat.id !== 'string')) ||
                (item.reply !== undefined &&
                    (!isObject(item.reply) ||
                        !['user', 'assistant'].includes(String(item.reply.role)) ||
                        typeof item.reply.text !== 'string')) ||
                (item.engine !== undefined && typeof item.engine !== 'string') ||
                (item.attachments !== undefined &&
                    (!Array.isArray(item.attachments) ||
                        !item.attachments.every(
                            file =>
                                isObject(file) &&
                                typeof file.id === 'string' &&
                                typeof file.name === 'string' &&
                                typeof file.mediaType === 'string' &&
                                typeof file.size === 'number'
                        ))) ||
                (item.firstMessage !== undefined &&
                    (!isObject(item.firstMessage) ||
                        !commandSchema.safeParse({
                            ...item.firstMessage,
                            type: 'chat.send',
                            chatId: 'pending',
                            requestId: 'pending-1',
                        }).success)) ||
                (item.operation !== undefined &&
                    (!commandSchema.safeParse(item.operation).success ||
                        !isObject(item.operation) ||
                        !['chat.create', 'chat.send'].includes(String(item.operation.type))))
            )
                return false;
            ids.add(item.id);
            return true;
        })
        .map(({ id, folderId, workspace, doc, createdChat, operation, firstMessage, attachments, reply, engine }) => ({
            id,
            folderId,
            workspace,
            doc,
            ...(createdChat && { createdChat }),
            ...(operation && { operation }),
            ...(firstMessage && { firstMessage }),
            ...(attachments && { attachments }),
            ...(reply && { reply }),
            ...(engine && { engine }),
        }));
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
        const existing = this.findPlace(folderId, workspace);
        if (existing) return existing;
        const draft: NewChatDraft = { id: crypto.randomUUID(), folderId, workspace, doc: emptyComposerDoc() };
        this.drafts = [...this.drafts, draft];
        this.persist();
        return draft;
    }

    findPlace(folderId: FolderId | null, workspace: ChatWorkspaceChoice | null): NewChatDraft | undefined {
        return this.drafts.find(draft => draft.folderId === folderId && sameWorkspace(draft.workspace, workspace));
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

    updateOperation(
        id: string,
        operation: NewChatDraft['operation'],
        createdChat?: Chat,
        firstMessage?: NewChatDraft['firstMessage'],
        attachments?: readonly Attachment[],
        reply?: ReplyMessage
    ): boolean {
        const before = this.drafts;
        this.drafts = this.drafts.map(draft =>
            draft.id === id
                ? {
                      ...draft,
                      operation,
                      createdChat: createdChat ?? draft.createdChat,
                      firstMessage: firstMessage ?? draft.firstMessage,
                      attachments: attachments ?? draft.attachments,
                      reply: reply ?? draft.reply,
                  }
                : draft
        );
        try {
            if (!this.#storage) throw new Error('Storage unavailable');
            const value = JSON.stringify(
                this.drafts.filter(
                    draft =>
                        nonempty(draft.doc) ||
                        draft.operation ||
                        draft.firstMessage ||
                        draft.attachments?.length ||
                        draft.reply
                )
            );
            this.#storage.setItem(this.#key, value);
            if (this.#storage.getItem(this.#key) !== value) throw new Error('Storage unavailable');
            return true;
        } catch {
            this.drafts = before;
            return false;
        }
    }

    updateAttachments(id: string, attachments: readonly Attachment[]): void {
        this.drafts = this.drafts.map(draft => (draft.id === id ? { ...draft, attachments } : draft));
        this.persist();
    }

    updateReply(id: string, reply?: ReplyMessage): void {
        this.drafts = this.drafts.map(draft => (draft.id === id ? { ...draft, reply } : draft));
        this.persist();
    }

    updateEngine(id: string, engine: string | null): void {
        this.drafts = this.drafts.map(draft => (draft.id === id ? { ...draft, engine: engine ?? undefined } : draft));
        this.persist();
    }

    clearRefused(id: string): boolean {
        const before = this.drafts;
        this.drafts = this.drafts.map(draft =>
            draft.id === id ? { ...draft, operation: undefined, firstMessage: undefined } : draft
        );
        try {
            if (!this.#storage) throw new Error('Storage unavailable');
            const value = JSON.stringify(
                this.drafts.filter(
                    draft =>
                        nonempty(draft.doc) ||
                        draft.operation ||
                        draft.firstMessage ||
                        draft.attachments?.length ||
                        draft.reply
                )
            );
            this.#storage.setItem(this.#key, value);
            if (this.#storage.getItem(this.#key) !== value) throw new Error('Storage unavailable');
            return true;
        } catch {
            this.drafts = before;
            return false;
        }
    }

    remove(id: string): void {
        this.drafts = this.drafts.filter(draft => draft.id !== id);
        this.persist();
    }

    private persist(): void {
        writeStored(
            this.#storage,
            this.#key,
            this.drafts.filter(
                draft =>
                    nonempty(draft.doc) ||
                    draft.operation ||
                    draft.firstMessage ||
                    draft.attachments?.length ||
                    draft.reply
            )
        );
    }
}
