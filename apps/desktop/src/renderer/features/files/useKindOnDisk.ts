import { useEffect, useState } from 'react';

import { useRootStore } from '../../stores';
import { placeKey, placeRef } from '../sidePanel/currentPlace';
import { kindOnDisk } from './openInFiles';

import type { FileKind } from '@clowdy/file-manager';
import type { ProjectId } from '@clowdy/protocol';
import type { Place } from '../sidePanel/currentPlace';

/**
 * What a path inside a place is on the disk, a file or a folder, read when the component is drawn and again for another path: for a path that was written without
 * a trailing slash and is a folder after all. `undefined` until the answer for this path comes (never another path's), and `null` when the disk says it is not there.
 * A read that fails leaves it `undefined`: nothing is known.
 */
export function useKindOnDisk(projectId: ProjectId, place: Place, relative: string): FileKind | null | undefined {
    const root = useRootStore();
    // The parts of the place, not the place: a caller that builds the object again on every draw would otherwise read again on every draw.
    const { folder, workspace } = place;
    const key = `${ projectId }/${ placeKey(placeRef(place)) }/${ relative }`;
    const [read, setRead] = useState<{ key: string; kind: FileKind | null }>();

    useEffect(() => {
        let isCurrent = true;

        kindOnDisk(root, projectId, workspace ? { folder, workspace } : { folder }, relative).then(
            (kind) => {
                if (isCurrent) setRead({ key, kind: kind ?? null });
            },
            () => undefined
        );

        return () => {
            isCurrent = false;
        };
    }, [root, projectId, folder, workspace, relative, key]);

    return read?.key === key ? read.kind : undefined;
}
