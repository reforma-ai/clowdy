import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { tempDir, waitFor } from './helpers';

import type { FolderId, FsWatchEvent, Project } from '@clowdy/protocol';
import type { FsService } from '../src/fs/service';
import type { Harness } from './helpers';

/** Writes files (and the folders above them) under `root`. */
export function put(root: string, files: Record<string, string | Uint8Array>): void {
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
}

export interface OpenFolder {
    project: Project;
    folderId: FolderId;
    /** The real path of the folder. */
    dir: string;
    fs: FsService;
}

/** A project with one folder of real files, its path as the daemon keeps it. */
export function openFolder(h: Harness, files: Record<string, string | Uint8Array> = {}): OpenFolder {
    const dir = tempDir('fs');

    put(dir, files);

    const { project } = h.ok('project.add', { folders: [dir] });

    return { project, folderId: project.folders[0].id, dir: project.folders[0].path, fs: h.daemon.services.fs };
}

/** Reads a Server-Sent Events body and keeps the `FsWatchEvent` of every `data:` line. */
export class EventReader {
    readonly events: FsWatchEvent[] = [];
    /** The raw text received, comments included. */
    text = '';
    private reader: ReturnType<ReadableStream<Uint8Array>['getReader']>;
    private done: Promise<void>;

    constructor(body: ReadableStream<Uint8Array>) {
        const decoder = new TextDecoder();
        let pending = '';

        const reader = body.getReader();

        this.reader = reader;
        this.done = (async () => {
            for (;;) {
                const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));

                if (done) {
                    return;
                }

                const chunk = decoder.decode(value, { stream: true });

                this.text += chunk;
                pending += chunk;

                for (let end = pending.indexOf('\n\n'); end !== -1; end = pending.indexOf('\n\n')) {
                    const frame = pending.slice(0, end);

                    pending = pending.slice(end + 2);

                    for (const line of frame.split('\n')) {
                        if (line.startsWith('data: ')) {
                            this.events.push(JSON.parse(line.slice(6)) as FsWatchEvent);
                        }
                    }
                }
            }
        })();
    }

    /** The next `count` events after the ones already taken, waiting for them. */
    async next(count = 1, timeoutMs = 4000): Promise<FsWatchEvent[]> {
        const from = this.taken;

        await waitFor(() => this.events.length >= from + count, `${ count } more watch events`, timeoutMs);
        this.taken = from + count;

        return this.events.slice(from, from + count);
    }

    /** Waits until nothing new has arrived for `quietMs`, and answers what came since the last read. */
    async quiet(quietMs = 400): Promise<FsWatchEvent[]> {
        let seen = -1;

        while (seen !== this.events.length) {
            seen = this.events.length;
            await new Promise(resolve => setTimeout(resolve, quietMs));
        }

        const rest = this.events.slice(this.taken);

        this.taken = this.events.length;

        return rest;
    }

    async close(): Promise<void> {
        await this.reader.cancel().catch(() => undefined);
        await this.done;
    }

    /** Whether the stream ended by itself. */
    get ended(): Promise<void> {
        return this.done;
    }

    private taken = 0;
}
