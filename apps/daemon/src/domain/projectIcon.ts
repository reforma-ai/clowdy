import { readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

import { realPathBelow } from '../docs/paths';

/** The largest icon file the daemon serves: a favicon is a few kilobytes, and a bigger picture is not one. */
export const MAX_ICON_FILE_BYTES = 512 * 1024;

const MEDIA_TYPES: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

/** Where web and app projects keep their icon below a project root: the root, the static folders of most web tools, Next's `app`, Expo's `assets`, electron-builder's `build`. */
const PLACES = ['', 'public', 'static', 'app', 'src/app', 'src', 'assets', 'build'];

/** The names an icon goes by, best first: a drawing scales, an app icon is large, a `.ico` is small. */
const NAMES = ['favicon.svg', 'icon.svg', 'apple-touch-icon.png', 'icon.png', 'favicon.png', 'favicon.ico'];

/** The folders of a monorepo whose packages may have the icon when its root has none. */
const WORKSPACES = ['apps', 'packages'];

export interface ProjectIconFile {
    /** Its real path, inside the folder it was found for. */
    path: string;
    mediaType: string;
}

/**
 * The icon of the project in `folder`: the first file of `NAMES` in one of `PLACES`, looked for in the folder itself and then in each package
 * of `apps/` and `packages/`, in name order. A file that leads out of the folder through a link, is empty, or is larger than
 * `MAX_ICON_FILE_BYTES` is passed over. Read at every ask, so a favicon added since shows the next time the app asks.
 */
export function findProjectIcon(folder: string): ProjectIconFile | undefined {
    for (const root of [folder, ...packageRoots(folder)]) {
        for (const place of PLACES) {
            for (const name of NAMES) {
                const icon = iconFile(folder, join(root, place, name));

                if (icon) return icon;
            }
        }
    }

    return undefined;
}

function packageRoots(folder: string): string[] {
    return WORKSPACES.flatMap((workspace) => {
        try {
            return readdirSync(join(folder, workspace), { withFileTypes: true })
                .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
                .map(entry => join(folder, workspace, entry.name))
                .sort();
        }
        catch {
            return [];
        }
    });
}

function iconFile(folder: string, path: string): ProjectIconFile | undefined {
    const real = realPathBelow(folder, path);

    if (!real) return undefined;

    try {
        const stat = statSync(real);

        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ICON_FILE_BYTES) return undefined;
    }
    catch {
        return undefined;
    }

    return { path: real, mediaType: MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream' };
}
