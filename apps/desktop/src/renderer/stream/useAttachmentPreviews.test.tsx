// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StreamLinksContext } from './StreamLinks';
import { useAttachmentPreviews } from './useAttachmentPreviews';

import type { Attachment } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const picture: Attachment = { id: 'a-1', name: 'shot.png', mediaType: 'image/png', size: 3 };
const log: Attachment = { id: 'a-2', name: 'error.log', mediaType: 'text/plain', size: 3 };
const page: Attachment = { id: 'a-3', name: 'page.html', mediaType: 'text/html', size: 3 };

let container: HTMLDivElement;
let root: Root;
let shown: ReadonlyMap<string, string>;
const created: Blob[] = [];
const revoked: string[] = [];

function Probe({ attachments }: { attachments: Attachment[] }) {
    shown = useAttachmentPreviews(attachments);

    return null;
}

beforeEach(() => {
    container = document.createElement('div');
    root = createRoot(container);
    created.length = 0;
    revoked.length = 0;
    URL.createObjectURL = (blob: Blob | MediaSource) => {
        created.push(blob as Blob);

        return `blob:preview-${created.length}`;
    };
    URL.revokeObjectURL = (url: string) => void revoked.push(url);
});

afterEach(() => act(() => root.unmount()));

describe('useAttachmentPreviews', () => {
    it('fetches only the pictures, shows them as what the message says they are, and lets go of them with the message', async () => {
        const attachmentBlob = vi.fn(async () => new Blob(['bytes'], { type: 'application/octet-stream' }));

        await act(async () =>
            root.render(
                <StreamLinksContext value={{ attachmentBlob }}>
                    <Probe attachments={[picture, log, page]} />
                </StreamLinksContext>
            )
        );

        expect(attachmentBlob).toHaveBeenCalledTimes(1);
        expect(attachmentBlob).toHaveBeenCalledWith(picture);
        expect(created[0]?.type).toBe('image/png');
        expect([...shown]).toEqual([['a-1', 'blob:preview-1']]);

        await act(async () => root.unmount());

        expect(revoked).toEqual(['blob:preview-1']);

        root = createRoot(container);
    });

    it('shows nothing when the stream cannot fetch files, or a file cannot be fetched', async () => {
        await act(async () => root.render(<Probe attachments={[picture]} />));

        expect(shown.size).toBe(0);

        await act(async () =>
            root.render(
                <StreamLinksContext
                    value={{
                        attachmentBlob: async () => {
                            throw new Error('gone');
                        },
                    }}
                >
                    <Probe attachments={[picture]} />
                </StreamLinksContext>
            )
        );

        expect(shown.size).toBe(0);
    });
});
