import { formatFileSize } from '@clowdy/lib';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_BYTES_PER_MESSAGE, MAX_ATTACHMENTS_PER_MESSAGE } from '@clowdy/protocol';
import { useSyncExternalStore } from 'react';

import { isPicture } from '../../shared/pictures';

import type { Attachment } from '@clowdy/protocol';

/** One file in the message box: picked, uploading, or uploaded and waiting for the message. */
export interface DraftFile {
    /** Tells the tile apart; the daemon's id only exists once the upload is done. */
    key: string;
    name: string;
    mediaType: string;
    size: number;
    /** A `blob:` URL of an image, for as long as the composer holds the file. */
    preview?: string;
    status: 'uploading' | 'ready' | 'error';
    /** Why the upload failed. */
    error?: string;
    /** The daemon's record, once the file is uploaded. */
    attachment?: Attachment;
    /** The file belongs to a message that was sent already (an edit started from it): taking it off the box or letting go of it must never delete the daemon's copy. */
    sent?: true;
    /** Kept so a failed upload can be tried again. */
    source?: File;
}

/**
 * The files of each message box (one per chat, and one per project for the new-chat page, since a file belongs to the project it
 * was uploaded to), kept apart from the component: an upload ends after the person went to another chat.
 */
const drafts = new Map<string, readonly DraftFile[]>();
const listeners = new Set<() => void>();
const NONE: readonly DraftFile[] = [];
let revision = 0;

const changed = () => {
    revision++;
    listeners.forEach(listener => listener());
};

function subscribe(listener: () => void): () => void {
    listeners.add(listener);

    return () => void listeners.delete(listener);
}

export function filesOf(key: string): readonly DraftFile[] {
    return drafts.get(key) ?? NONE;
}

export function setFiles(key: string, files: readonly DraftFile[]): void {
    if (files.length === 0) drafts.delete(key);
    else drafts.set(key, files);

    changed();
}

/** Changes one file, if it is still there. */
export function patchFile(key: string, fileKey: string, patch: Partial<DraftFile>): boolean {
    const files = filesOf(key);

    if (!files.some(file => file.key === fileKey)) return false;

    setFiles(
        key,
        files.map(file => (file.key === fileKey ? { ...file, ...patch } : file))
    );

    return true;
}

/** Hands the files over for sending, and leaves the box without them. */
export function takeFiles(key: string): readonly DraftFile[] {
    const files = filesOf(key);

    setFiles(key, NONE);

    return files;
}

/** Puts files back in front of what was added meanwhile, when their message did not go. */
export function restoreFiles(key: string, files: readonly DraftFile[]): void {
    setFiles(key, [...files, ...filesOf(key)]);
}

/** Lets go of what the composer held for a file that is not shown any more. */
export function releaseFiles(files: readonly DraftFile[]): void {
    for (const file of files) {
        if (file.preview) URL.revokeObjectURL(file.preview);
    }
}

export function useDraftFiles(key: string): readonly DraftFile[] {
    return useSyncExternalStore(subscribe, () => filesOf(key));
}

export function useDraftFilesRevision() {
    return useSyncExternalStore(subscribe, () => revision);
}

export function draftFileOf(file: File): DraftFile {
    const mediaType = file.type || 'application/octet-stream';

    return {
        key: crypto.randomUUID(),
        name: file.name,
        mediaType,
        size: file.size,
        preview: isPicture(mediaType) ? URL.createObjectURL(file) : undefined,
        status: 'uploading',
        source: file,
    };
}

const sameFile = (draft: DraftFile, file: File) => draft.name === file.name && draft.size === file.size;

/** Which of the files may join those in the box, and why the others may not (one line each, for the person). */
export function admitFiles(
    held: readonly DraftFile[],
    incoming: readonly File[]
): { accepted: File[]; refusals: string[] } {
    const accepted: File[] = [];
    const refusals: string[] = [];
    let count = held.length;
    let bytes = held.reduce((sum, file) => sum + file.size, 0);

    for (const file of incoming) {
        if (
            held.some(draft => sameFile(draft, file)) ||
            accepted.some(other => other.name === file.name && other.size === file.size)
        )
            continue;

        if (file.size > MAX_ATTACHMENT_BYTES) {
            refusals.push(
                `${file.name} is over the ${formatFileSize(MAX_ATTACHMENT_BYTES, { round: 'up' })} limit of one file.`
            );
        } else if (count >= MAX_ATTACHMENTS_PER_MESSAGE) {
            refusals.push(`${file.name} was left out: a message takes ${MAX_ATTACHMENTS_PER_MESSAGE} files at most.`);
        } else if (bytes + file.size > MAX_ATTACHMENTS_BYTES_PER_MESSAGE) {
            refusals.push(
                `${file.name} was left out: a message takes ${formatFileSize(MAX_ATTACHMENTS_BYTES_PER_MESSAGE, { round: 'up' })} of files at most.`
            );
        } else {
            accepted.push(file);
            count += 1;
            bytes += file.size;
        }
    }

    return { accepted, refusals };
}
