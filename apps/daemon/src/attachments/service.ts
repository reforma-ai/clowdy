import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_BYTES_PER_MESSAGE, MAX_ATTACHMENTS_PER_MESSAGE } from '@clowdy/protocol';
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import {
    allAttachmentIds,
    deleteAttachment,
    deleteAttachmentsOfChat,
    deleteAttachmentsOfProject,
    getAttachment,
    insertAttachment,
    markAttachmentsSent,
    markAttachmentsUnsent,
    unsentAttachmentIdsBefore,
} from '../db/attachments';
import { conflict, invalid, notFound, TooLargeError } from '../errors';
import { newId } from '../ids';
import { formatSize } from './message';
import { mediaTypeOf, safeFileName } from './names';

import type { Attachment, Project } from '@clowdy/protocol';
import type { FileHandle } from 'node:fs/promises';
import type { AttachmentRecord } from '../db/attachments';
import type { Store } from '../store';

/** A file that was uploaded and never sent is removed after this long. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export const toAttachment = ({ id, name, mediaType, size }: AttachmentRecord): Attachment => ({ id, name, mediaType, size });

const tooLarge = () => new TooLargeError(`A file may be at most ${ formatSize(MAX_ATTACHMENT_BYTES) }`, { maxBytes: MAX_ATTACHMENT_BYTES });

/** What the HTTP route hands over: the request, reduced to what storing it needs. */
export interface Upload {
    /** The `name` query parameter, as sent. */
    name: string | null;
    /** The request's `Content-Type`. */
    contentType: string | null;
    /** `null` when the request had no body at all. */
    body: AsyncIterable<Uint8Array> | null;
    /** The `Content-Length` the client declared; 0 when it sent none. */
    declaredLength: number;
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
    for (let offset = 0; offset < chunk.length;) {
        offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
    }
}

/**
 * Files attached to messages. The bytes are `<dataDir>/attachments/<id>/<name>`: the folder is unique, so the file keeps the name the
 * person gave it, which is what the agent reads in the message. A row in `attachments` says whose it is and whether a message
 * has claimed it. Uploads never emit an event (only the uploader needs the answer); the message that sends a file does, and carries it.
 */
export class AttachmentsService {
    readonly root: string;
    /** Folders of uploads still being written: the sweep must not take them for strays. */
    private uploading = new Set<string>();

    constructor(private store: Store, dataDir: string) {
        this.root = join(dataDir, 'attachments');
    }

    /** Where the bytes of a file are. */
    pathOf(record: Pick<AttachmentRecord, 'id' | 'name'>): string {
        return join(this.root, record.id, record.name);
    }

    /**
     * Stores the body as a file of the project and returns it. A declared length over the limit is refused unread; the body is also
     * read in chunks and cut off at `MAX_ATTACHMENT_BYTES`, so a client that lies about, or hides, its length cannot fill the disk.
     * A failed or refused upload leaves nothing behind.
     */
    async upload(project: Project, { name: rawName, contentType, body, declaredLength }: Upload): Promise<Attachment> {
        if (rawName === null || !rawName.trim()) {
            throw invalid('The file needs a name: pass it as ?name=');
        }

        if (declaredLength > MAX_ATTACHMENT_BYTES) {
            throw tooLarge();
        }

        if (body === null) {
            throw invalid('The file is empty');
        }

        this.sweep();

        const name = safeFileName(rawName);
        const id = newId('att');
        const folder = join(this.root, id);
        let size = 0;

        this.uploading.add(id);

        try {
            // Screenshots and documents of the person: readable by them alone, like the other files the daemon keeps.
            mkdirSync(folder, { recursive: true, mode: 0o700 });

            const handle = await open(join(folder, name), 'wx', 0o600);

            try {
                for await (const chunk of body) {
                    size += chunk.length;

                    if (size > MAX_ATTACHMENT_BYTES) {
                        throw tooLarge();
                    }

                    await writeAll(handle, chunk);
                }
            }
            finally {
                await handle.close();
            }

            if (size === 0) {
                throw invalid('The file is empty');
            }

            const record: AttachmentRecord = { id, name, mediaType: mediaTypeOf(contentType, name), size, projectId: project.id, createdAt: Date.now() };

            this.store.tx(() => insertAttachment(this.store.db, record));

            return toAttachment(record);
        }
        catch (error) {
            this.removeFolder(id);
            throw error;
        }
        finally {
            this.uploading.delete(id);
        }
    }

    /** A file of the project and where its bytes are; `not_found` for an unknown id, for another project's file and for one whose bytes are gone. */
    read(projectId: string, attachmentId: string): { record: AttachmentRecord; path: string } {
        const record = this.require(projectId, attachmentId);
        const path = this.pathOf(record);

        if (!existsSync(path)) {
            throw notFound('The file of attachment', attachmentId);
        }

        return { record, path };
    }

    /** Removes a file that no message has claimed. */
    remove(projectId: string, attachmentId: string): void {
        this.store.tx(() => {
            const record = this.require(projectId, attachmentId);

            if (record.chatId) {
                throw conflict('This file was sent with a message and stays with it');
            }

            deleteAttachment(this.store.db, attachmentId);
            this.store.afterCommit(() => this.removeFolder(attachmentId));
        });
    }

    /**
     * The files a message to a chat of this project may carry, in the order given. The same checks whether the chat is new or not:
     * at most `MAX_ATTACHMENTS_PER_MESSAGE`, each listed once, each uploaded to this project and not sent yet, and the total size
     * within `MAX_ATTACHMENTS_BYTES_PER_MESSAGE`.
     */
    claim(projectId: string, ids: readonly string[]): AttachmentRecord[] {
        if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) {
            throw invalid(`A message may carry at most ${ MAX_ATTACHMENTS_PER_MESSAGE } files`);
        }

        if (new Set(ids).size !== ids.length) {
            throw invalid('A file is listed more than once');
        }

        const records = ids.map((id) => {
            const record = getAttachment(this.store.db, id);

            if (record?.projectId !== projectId) {
                throw notFound('Attachment', id);
            }

            if (record.chatId) {
                throw conflict(`Attachment ${ id } was sent with another message already`);
            }

            return record;
        });

        if (records.reduce((total, record) => total + record.size, 0) > MAX_ATTACHMENTS_BYTES_PER_MESSAGE) {
            throw invalid(`A message may carry at most ${ formatSize(MAX_ATTACHMENTS_BYTES_PER_MESSAGE) } of files`);
        }

        return records;
    }

    /** Marks claimed files as sent with this chat and run. Call it in the transaction that adds the message. */
    markSent(records: readonly AttachmentRecord[], chatId: string, runId: string): void {
        if (markAttachmentsSent(this.store.db, records.map(record => record.id), chatId, runId) !== records.length) {
            throw conflict('A file was sent with another message already');
        }
    }

    /**
     * Gives the files of a message that will not be sent back to the project, unsent: a message box takes them again (the person edits a queued message).
     * They count as uploaded now, so the sweep of unsent files gives the person as long as for any upload. Call it in the transaction that drops the message.
     */
    release(ids: readonly string[]): void {
        markAttachmentsUnsent(this.store.db, [...ids], Date.now());
    }

    /** Drops the files of a message that will not be sent (a queued message the person removed): the rows now, the folders once the transaction commits. */
    discard(ids: readonly string[]): void {
        ids.forEach(id => deleteAttachment(this.store.db, id));
        this.store.afterCommit(() => ids.forEach(id => this.removeFolder(id)));
    }

    /**
     * Gives a chat its own copy of files sent in another chat of the project (the messages a fork inherits): each file gets a new id, its own bytes and a
     * row sent with `chatId` and `runId`, so deleting the source takes none of the fork's files, and the other way round. Returns the copy of each file by
     * the id it had, and `undo`, which removes the folders again when the transaction the caller is in fails after this (the rows go with the rollback).
     * A file that cannot be copied (the source's row or bytes are gone, or the disk refuses) is left out of `copies`: it was no better in the source, and
     * the message keeps naming the file it had. Call it in the transaction that makes the chat.
     */
    copyInto(files: readonly Attachment[], target: { projectId: string; chatId: string; runId: string }): { copies: Map<string, Attachment>; undo: () => void } {
        const copies = new Map<string, Attachment>();
        const folders: string[] = [];
        const now = Date.now();

        for (const file of files) {
            const record = getAttachment(this.store.db, file.id);

            if (copies.has(file.id) || record?.projectId !== target.projectId || !existsSync(this.pathOf(record))) {
                continue;
            }

            const id = newId('att');
            const folder = join(this.root, id);

            try {
                mkdirSync(folder, { recursive: true, mode: 0o700 });
                folders.push(id);
                // A copy-on-write clone where the disk has them, a plain copy where it does not.
                copyFileSync(this.pathOf(record), join(folder, record.name), constants.COPYFILE_FICLONE);
                insertAttachment(this.store.db, { ...record, id, chatId: target.chatId, runId: target.runId, createdAt: now });
                copies.set(file.id, { ...toAttachment(record), id });
            }
            catch (error) {
                console.warn(`[clowdy] copying attachment ${ file.id } into a fork failed:`, error);
                this.removeFolder(id);
            }
        }

        return { copies, undo: () => folders.forEach(id => this.removeFolder(id)) };
    }

    /** Drops the files sent in a chat: the rows now, the folders once the transaction commits. Call it in the transaction that deletes the chat. */
    removeOfChat(chatId: string): void {
        const ids = deleteAttachmentsOfChat(this.store.db, chatId);

        this.store.afterCommit(() => ids.forEach(id => this.removeFolder(id)));
    }

    /** Drops every file of a project, unsent ones too: the rows now, the folders once the transaction commits. Call it in the transaction that deletes the project. */
    removeOfProject(projectId: string): void {
        const ids = deleteAttachmentsOfProject(this.store.db, projectId);

        this.store.afterCommit(() => ids.forEach(id => this.removeFolder(id)));
    }

    /**
     * Removes files uploaded before `now - STALE_AFTER_MS` that no message claimed, and folders no row knows (a crash between the
     * folder and the row, a row removed by hand). Runs at start and before every upload; best effort.
     */
    sweep(now = Date.now()): void {
        try {
            const stale = unsentAttachmentIdsBefore(this.store.db, now - STALE_AFTER_MS);

            if (stale.length > 0) {
                this.store.tx(() => {
                    stale.forEach(id => deleteAttachment(this.store.db, id));
                    this.store.afterCommit(() => stale.forEach(id => this.removeFolder(id)));
                });
            }

            const known = allAttachmentIds(this.store.db);

            for (const entry of existsSync(this.root) ? readdirSync(this.root) : []) {
                if (!known.has(entry) && !this.uploading.has(entry)) {
                    this.removeFolder(entry);
                }
            }
        }
        catch (error) {
            console.warn('[clowdy] sweeping attachments failed:', error);
        }
    }

    private require(projectId: string, attachmentId: string): AttachmentRecord {
        const record = getAttachment(this.store.db, attachmentId);

        if (record?.projectId !== projectId) {
            throw notFound('Attachment', attachmentId);
        }

        return record;
    }

    private removeFolder(id: string): void {
        try {
            rmSync(join(this.root, id), { recursive: true, force: true });
        }
        catch (error) {
            console.warn(`[clowdy] removing the folder of attachment ${ id } failed:`, error);
        }
    }
}
