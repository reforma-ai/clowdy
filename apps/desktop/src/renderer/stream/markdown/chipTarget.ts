import { absolutePath, type OpenTarget } from '../../features/openWith';
import { type Place, placePath } from '../../features/sidePanel/currentPlace';

import type { ProjectFolder, ProjectId } from '@clowdy/protocol';

/** Whether a chip's path (forward slashes) is a full path on the disk, a drive letter or a leading slash, and not one that is written from the project's folder. */
export const isAbsolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:\//.test(path);

/** A folder's path as a chip writes paths: forward slashes, no trailing one. */
const slashed = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '');

/** The parts of a path inside a folder with `.` and `..` settled, or nothing when it climbs out of the folder. */
function inside(parts: readonly string[]): string[] | undefined {
    const settled: string[] = [];

    for (const part of parts) {
        if (part === '' || part === '.') continue;

        if (part !== '..') settled.push(part);
        else if (settled.pop() === undefined) return undefined;
    }

    return settled;
}

export interface ChipPath {
    /** The path a chip names, as `normalizeChipPath` leaves it: forward slashes, no leading `./`. Empty for the project's folder. */
    path: string;
    kind: OpenTarget['kind'];
}

/** Whether an absolute path is `root` or below it, the two as a chip writes paths. */
const isUnder = (path: string, root: string) => path === slashed(root) || path.startsWith(`${slashed(root)}/`);

/**
 * What a chip's path is in the project: a path inside the open chat's place (`current`: the folder it works in, or the worktree of that folder when it has one) when it is
 * relative; when it is absolute, inside that worktree if it is under it, else the folder of the project that holds it, in its own checkout. Nothing for a path outside every
 * folder of the project and the worktree, or one that climbs out of its folder with `..`.
 */
export function resolveChipTarget(
    { path, kind }: ChipPath,
    projectId: ProjectId,
    folders: readonly ProjectFolder[],
    current: Place
): OpenTarget | undefined {
    let { folder, workspace } = current;
    let parts: string[] | undefined;

    if (isAbsolute(path)) {
        // The worktree is not below any folder of the project (it is in `~/Clowdy/workspaces`), so the chat's own is asked first.
        if (workspace && isUnder(path, workspace.path)) {
            parts = inside(path.slice(slashed(workspace.path).length).split('/'));
        } else {
            const holder = folders.find(candidate => isUnder(path, candidate.path));

            if (!holder) return undefined;

            folder = holder;
            workspace = undefined;
            parts = inside(path.slice(slashed(holder.path).length).split('/'));
        }
    } else {
        parts = inside(path.split('/'));
    }

    if (!parts) return undefined;

    const relative = parts.join('/');
    const root = placePath({ folder, workspace });

    return {
        projectId,
        folder,
        ...(workspace && { workspace }),
        path: absolutePath(root, relative),
        relative,
        kind: relative === '' ? 'directory' : kind,
    };
}
