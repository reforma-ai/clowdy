import { Button } from '@clowdy/components/Button';
import { Badge } from '@clowdy/components/Tag';
import { Text } from '@clowdy/components/Text';
import { Close, Folder } from '@clowdy/icons/14';

import { CardRow } from '../shared/CardRow';

import type { ReactNode } from 'react';

export interface FolderRowProps {
    /** The short name `folderNames` gives it among the project's folders. */
    name: string;
    path: string;
    /** The first folder of a project, where its agents work. */
    isMain?: boolean;
    /** Lines under the path: a warning. */
    children?: ReactNode;
    /** Buttons before Remove: Open in GitHub. */
    actions?: ReactNode;
    /** Absent: the folder cannot be removed here, and the row has no Remove button. */
    onRemove?: () => void;
    isRemoveDisabled?: boolean;
}

/**
 * One folder of a project's list (`FolderList`), the same card row as a project of Settings > Projects: its name with the Main mark, its
 * path, and Remove. `data-folder-path` lets a list find the row of a folder, to move the focus there.
 */
export function FolderRow({ name, path, isMain = false, children, actions, onRemove, isRemoveDisabled = false }: FolderRowProps) {
    return (
        <CardRow
            data-folder-path={ path }
            icon={ <Folder /> }
            title={ <Text weight="medium" truncate>{ name }</Text> }
            marks={ isMain && <Badge size="xs" textValue="Main">Main</Badge> }
            actions={ (actions || onRemove) && (
                <>
                    { actions }
                    { onRemove && (
                        <Button iconOnly size="sm" variant="filling" color="secondary" aria-label={ `Remove ${ name }` } isDisabled={ isRemoveDisabled } onPress={ onRemove }>
                            <Close />
                        </Button>
                    ) }
                </>
            ) }
        >
            <Text variant="sm" color="secondary" truncate title={ path }>{ path }</Text>
            { children }
        </CardRow>
    );
}
