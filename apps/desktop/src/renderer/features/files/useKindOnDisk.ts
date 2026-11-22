import { useEffect, useState } from 'react';

import { useRootStore } from '../../stores';
import { kindOnDisk } from './openInFiles';

import type { FileKind } from '@clowdy/file-manager';
import type { ProjectFolder, ProjectId } from '@clowdy/protocol';

/**
 * What a path inside a folder is on the disk, a file or a folder, read when the component is drawn and again for another path: for a path that was written without
 * a trailing slash and is a folder after all. Nothing until the answer for this path comes (never another path's), and nothing when it is not there.
 */
export function useKindOnDisk(projectId: ProjectId, folder: ProjectFolder, relative: string): FileKind | undefined {
    const root = useRootStore();
    const key = `${ projectId }/${ folder.id }/${ relative }`;
    const [read, setRead] = useState<{ key: string; kind: FileKind | undefined }>();

    useEffect(() => {
        let isCurrent = true;

        kindOnDisk(root, projectId, folder, relative).then(
            (kind) => {
                if (isCurrent) setRead({ key, kind });
            },
            () => undefined
        );

        return () => {
            isCurrent = false;
        };
    }, [root, projectId, folder, relative, key]);

    return read?.key === key ? read.kind : undefined;
}
