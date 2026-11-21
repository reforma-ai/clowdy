import { afterEach, describe, expect, test, vi } from 'vitest';

import { APP_ICON_SIZE, APP_ICON_TIMEOUT_MS, createAppIcon, type AppIconSources } from './appIcon';

import type { NativeImage } from 'electron';

const image = (url: string, empty = false) => ({ isEmpty: () => empty, toDataURL: () => url }) as unknown as NativeImage;

function sources(platform: NodeJS.Platform, overrides: Partial<AppIconSources> = {}) {
    const thumbnail = vi.fn<AppIconSources['thumbnail']>(async () => image('data:image/png;base64,thumbnail'));
    const fileIcon = vi.fn<AppIconSources['fileIcon']>(async () => image('data:image/png;base64,file'));

    return { thumbnail, fileIcon, read: createAppIcon({ platform, thumbnail, fileIcon, ...overrides }) };
}

describe('reading the icon of a program', () => {
    test('takes the thumbnail of an app on macOS, since the icon of the file type is the same blank one for every app', async () => {
        const { read, thumbnail, fileIcon } = sources('darwin');

        expect(await read('/Applications/Cursor.app')).toBe('data:image/png;base64,thumbnail');
        expect(thumbnail).toHaveBeenCalledExactlyOnceWith('/Applications/Cursor.app', APP_ICON_SIZE);
        expect(fileIcon).not.toHaveBeenCalled();
    });

    test('takes the icon of an executable on Windows', async () => {
        const { read, thumbnail, fileIcon } = sources('win32');

        expect(await read('C:\\Program Files\\Zed\\Zed.exe')).toBe('data:image/png;base64,file');
        expect(fileIcon).toHaveBeenCalledExactlyOnceWith('C:\\Program Files\\Zed\\Zed.exe');
        expect(thumbnail).not.toHaveBeenCalled();
    });

    test('gives nothing for an empty image and for a read that fails', async () => {
        const empty = sources('darwin', { thumbnail: async () => image('data:,', true) });
        const broken = sources('win32', { fileIcon: () => Promise.reject(new Error('No such file')) });

        expect(await empty.read('/Applications/Cursor.app')).toBeUndefined();
        expect(await broken.read('C:\\gone.exe')).toBeUndefined();
    });

    describe('a read that never answers', () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        test('gives nothing once the time is up, so the list of programs is not held back', async () => {
            vi.useFakeTimers();

            const { read } = sources('darwin', { thumbnail: () => new Promise<NativeImage>(() => undefined) });
            const pending = read('/Applications/Cursor.app');

            await vi.advanceTimersByTimeAsync(APP_ICON_TIMEOUT_MS);

            expect(await pending).toBeUndefined();
        });
    });
});
