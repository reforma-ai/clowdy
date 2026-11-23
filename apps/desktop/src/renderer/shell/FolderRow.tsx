import { Button } from '@clowdy/components/Button';
import { Badge } from '@clowdy/components/Tag';
import { Text } from '@clowdy/components/Text';
import { Close, Folder } from '@clowdy/icons/14';

import { PathText } from '../shared/PathText';
import styles from './FolderRow.module.css';

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
 * One folder inside the project's folder card (`FolderList`): its name with the Main mark, its path, and a quiet Remove at the end of the
 * row. The sizes are the list row's, as `ProjectRow` and the worktrees' rows have them: the name body (`md`) medium, the path `sm` and dim, the mark `xs`; a bare `Text` would
 * take the page's 16px, which the row's height (`--folder-row-min`, from `--leading-md`) does not count on. `data-folder-path` lets a list find the row of a folder, to move the focus there.
 */
export function FolderRow({ name, path, isMain = false, children, actions, onRemove, isRemoveDisabled = false }: FolderRowProps) {
    return (
        <div className={ styles.row } data-folder-path={ path }>
            <span className={ styles.icon }><Folder /></span>
            <span className={ styles.text }>
                <span className={ styles.title }>
                    <Text variant="md" weight="medium" truncate>{ name }</Text>
                    { isMain && <Badge size="xs" textValue="Main">Main</Badge> }
                </span>
                <PathText path={ path } variant="sm" color="secondary" />
                { children }
            </span>
            { (actions || onRemove) && (
                <span className={ styles.actions }>
                    { actions }
                    { onRemove && (
                        <Button iconOnly size="sm" variant="filling" color="secondary" aria-label={ `Remove ${ name }` } isDisabled={ isRemoveDisabled } onPress={ onRemove }>
                            <Close />
                        </Button>
                    ) }
                </span>
            ) }
        </div>
    );
}
