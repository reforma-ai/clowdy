import { Text } from '@clowdy/components/Text';
import { Folder } from '@clowdy/icons/14';

import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import styles from './ChatFolder.module.css';

/**
 * The folder a chat works in, read only, in the place the new-chat page's select (`DraftFolderSelect`) had it: the same size and the same name, with no plate and no
 * chevron, since the folder of a chat never changes. Hovering tells the path, or that the folder is gone from the disk.
 */
export function ChatFolder({ name, path, missing }: { name: string; path: string; missing: boolean }) {
    return (
        <div role="group" aria-label="Folder" className={ styles.folder } data-missing={ missing || undefined } title={ missing ? 'This folder no longer exists' : tildePath(path, homeFolder.path) }>
            <Folder aria-hidden="true" />
            <Text truncate>{ name }</Text>
        </div>
    );
}
