import { Button } from '@clowdy/components/Button';
import { Badge } from '@clowdy/components/Tag';
import { Text } from '@clowdy/components/Text';
import { Close, Folder } from '@clowdy/icons/14';

import styles from './FolderRow.module.css';

import type { ReactNode } from 'react';

export interface FolderRowProps {
    /** The short name `folderNames` gives it among the project's folders. */
    name: string;
    path: string;
    /** The first folder of a project, where its agents work. */
    isMain?: boolean;
    /** Lines under the path: the folder's remote, a warning. */
    children?: ReactNode;
    /** Absent: the folder cannot be removed here, and the row has no Remove button. */
    onRemove?: () => void;
    isRemoveDisabled?: boolean;
}

/**
 * One folder of a project's list, in the Add project form and on the project's page in Settings: its name with the Main mark, its path,
 * and Remove. `data-folder-path` lets a list find the row of a folder, to move the focus there.
 */
export function FolderRow({ name, path, isMain = false, children, onRemove, isRemoveDisabled = false }: FolderRowProps) {
    return (
        <div className={ styles.folder } data-folder-path={ path }>
            <span className={ styles.icon }><Folder /></span>
            <span className={ styles.text }>
                <span className={ styles.title }>
                    <Text variant="md" weight="medium" truncate>{ name }</Text>
                    { isMain && <Badge size="xs" textValue="Main">Main</Badge> }
                </span>
                <Text variant="sm" color="secondary" truncate title={ path }>{ path }</Text>
                { children }
            </span>
            { onRemove && (
                <Button iconOnly size="xs" variant="filling" color="secondary" aria-label={ `Remove ${ name }` } isDisabled={ isRemoveDisabled } onPress={ onRemove }>
                    <Close />
                </Button>
            ) }
        </div>
    );
}
