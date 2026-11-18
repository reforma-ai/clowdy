import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Badge } from '@clowdy/components/Tag';
import { Text } from '@clowdy/components/Text';
import { ChevronRight, Folder, Home, More, Trash } from '@clowdy/icons/14';

import styles from './ProjectRow.module.css';
import { holdingsLine } from './projectView';

import type { Project, ProjectInfo } from '@clowdy/protocol';

const OPEN = 'open';
const REMOVE = 'remove';

export interface ProjectRowProps {
    project: Project;
    info: ProjectInfo | undefined;
    /** Shows the project's page in Settings. */
    onManage: () => void;
    /** Leaves Settings for the project itself. */
    onOpen: () => void;
    /** Absent for the personal space: it cannot be removed. */
    onRemove?: () => void;
}

/** One project of the list: where it is and what it holds; a click opens its page, and its menu opens the project itself or removes it. */
export function ProjectRow({ project, info, onManage, onOpen, onRemove }: ProjectRowProps) {
    const holdings = holdingsLine(info);
    const missing = info !== undefined && !info.folderExists;

    return (
        <div className={ styles.row }>
            <button type="button" className={ styles.open } data-project-id={ project.id } onClick={ onManage }>
                <span className={ styles.icon }>{ project.personal ? <Home /> : <Folder /> }</span>
                <span className={ styles.text }>
                    <span className={ styles.title }>
                        <Text bold truncate>{ project.name }</Text>
                        { missing && <Badge size="xs" color="warning" textValue="Folder missing">Folder missing</Badge> }
                    </span>
                    <Text variant="sm" color="secondary" truncate title={ project.path }>{ project.path }</Text>
                    { holdings && <Text variant="xs" color="secondary">{ holdings }</Text> }
                </span>
                <ChevronRight className={ styles.chevron } aria-hidden />
            </button>

            <MenuTrigger>
                <Button variant="transparent" size="sm" iconOnly className={ styles.menu } aria-label={ `${ project.name } actions` }>
                    <More />
                </Button>
                <Popover placement="bottom end" width={ 200 }>
                    <Menu
                        aria-label={ `${ project.name } actions` }
                        size="md"
                        onAction={ (key) => {
                            if (key === OPEN) onOpen();
                            else if (key === REMOVE) onRemove?.();
                        } }
                    >
                        <MenuItem id={ OPEN } text="Open project" icon={ <Folder /> } />
                        { onRemove && <MenuItem id={ REMOVE } text="Remove…" icon={ <Trash /> } isDanger isDisabled={ (info?.activeRuns ?? 0) > 0 } /> }
                    </Menu>
                </Popover>
            </MenuTrigger>
        </div>
    );
}
