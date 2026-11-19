import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Badge } from '@clowdy/components/Tag';
import { Text } from '@clowdy/components/Text';
import { Folder, Home, More, Sliders, Trash } from '@clowdy/icons/14';
import { mainFolder } from '@clowdy/protocol';

import { SettingsCard } from '../ui/SettingsCard';
import styles from './ProjectRow.module.css';
import { holdingsLine } from './projectView';

import type { Project, ProjectInfo } from '@clowdy/protocol';

const CONFIGURE = 'configure';
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

/** One project of the list: where it is and what it holds. A click opens its page in Settings, and its menu configures the project, opens it or removes it. */
export function ProjectRow({ project, info, onManage, onOpen, onRemove }: ProjectRowProps) {
    const holdings = holdingsLine(info);
    const missing = info?.folders[0]?.exists === false;
    const path = mainFolder(project).path;

    return (
        <SettingsCard className={ styles.row }>
            <button type="button" className={ styles.open } data-project-id={ project.id } onClick={ onManage }>
                <span className={ styles.icon }>{ project.personal ? <Home /> : <Folder /> }</span>
                <span className={ styles.text }>
                    <span className={ styles.title }>
                        <Text weight="medium" truncate>{ project.name }</Text>
                        { missing && <Badge size="xs" color="warning" textValue="Folder missing">Folder missing</Badge> }
                    </span>
                    <Text variant="sm" color="secondary" truncate title={ path }>{ path }</Text>
                    { holdings && <Text variant="xs" color="secondary">{ holdings }</Text> }
                </span>
            </button>

            <MenuTrigger>
                <Button variant="filling" color="secondary" size="sm" iconOnly className={ styles.menu } aria-label={ `${ project.name } actions` }>
                    <More />
                </Button>
                <Popover placement="bottom end" width={ 200 }>
                    <Menu
                        aria-label={ `${ project.name } actions` }
                        size="md"
                        onAction={ (key) => {
                            if (key === CONFIGURE) onManage();
                            else if (key === OPEN) onOpen();
                            else if (key === REMOVE) onRemove?.();
                        } }
                    >
                        <MenuItem id={ CONFIGURE } text="Configure" icon={ <Sliders /> } />
                        <MenuItem id={ OPEN } text="Open project" icon={ <Folder /> } />
                        { onRemove && <MenuSeparator /> }
                        { onRemove && <MenuItem id={ REMOVE } text="Remove…" icon={ <Trash /> } isDanger isDisabled={ (info?.activeRuns ?? 0) > 0 } /> }
                    </Menu>
                </Popover>
            </MenuTrigger>
        </SettingsCard>
    );
}
