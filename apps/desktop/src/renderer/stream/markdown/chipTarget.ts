import { absolutePath, type OpenTarget } from '../../features/openWith';

import type { ProjectFolder, ProjectId } from '@clowdy/protocol';

const isAbsolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:\//.test(path);

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

/**
 * What a chip's path is in the project: a path inside the folder of the open chat (`current`) when it is relative, the folder of the project that holds it
 * when it is absolute. Nothing for a path outside every folder of the project, or one that climbs out of its folder with `..`.
 */
export function resolveChipTarget({ path, kind }: ChipPath, projectId: ProjectId, folders: readonly ProjectFolder[], current: ProjectFolder): OpenTarget | undefined {
    let folder = current;
    let parts: string[] | undefined;

    if (isAbsolute(path)) {
        const holder = folders.find((candidate) => {
            const root = slashed(candidate.path);

            return path === root || path.startsWith(`${ root }/`);
        });

        if (!holder) return undefined;

        folder = holder;
        parts = inside(path.slice(slashed(holder.path).length).split('/'));
    }
    else {
        parts = inside(path.split('/'));
    }

    if (!parts) return undefined;

    const relative = parts.join('/');

    return { projectId, folder, path: absolutePath(folder.path, relative), relative, kind: relative === '' ? 'directory' : kind };
}
