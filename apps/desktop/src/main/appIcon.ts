import type { NativeImage } from 'electron';

/** The side, in pixels, an icon is read at: twice the 16px it is drawn at, so it stays sharp on a high-density screen. */
export const APP_ICON_SIZE = 32;

/** How long an icon may take to read: the list of programs waits for it, so a read that never answers must not hold the list back. */
export const APP_ICON_TIMEOUT_MS = 3000;

/** What reading a program's icon needs from Electron, so the choice of the way can be tried without it. */
export interface AppIconSources {
    platform: NodeJS.Platform;
    /** A thumbnail of a file (`nativeImage.createThumbnailFromPath`), which for an app bundle is the app's own icon. */
    thumbnail: (path: string, size: number) => Promise<NativeImage>;
    /** The icon the system has for a file (`app.getFileIcon`), which for an executable is the one inside it. */
    fileIcon: (path: string) => Promise<NativeImage>;
}

/**
 * Reads the icon of a program as a `data:` image the page can draw, or nothing when there is none to read (the page then draws a plain icon).
 * `app.getFileIcon` is no use for an app on macOS: it gives the icon of the file's type, the same blank one for every `.app`, so the thumbnail
 * of the bundle is read there. On Windows the executable carries its icon, and `getFileIcon` reads it.
 */
export function createAppIcon({ platform, thumbnail, fileIcon }: AppIconSources, timeoutMs = APP_ICON_TIMEOUT_MS): (path: string) => Promise<string | undefined> {
    return async (path) => {
        try {
            const image = await within(platform === 'darwin' ? thumbnail(path, APP_ICON_SIZE) : fileIcon(path), timeoutMs);

            return image.isEmpty() ? undefined : image.toDataURL();
        }
        catch {
            return undefined;
        }
    };
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The icon took too long to read')), ms);

        promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
}
