import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { Check, ChevronDown, Folder, Plus } from '@clowdy/icons/14';

import { useRootStore } from '../stores';
import { openCreateProject, openExistingProject } from './projectDialogs';
import styles from './ProjectSelect.module.css';

const CREATE = 'create-project';
const OPEN = 'open-project';

/** The project switcher in the title band: the projects, then "Create project" and "Open existing project…". */
export function ProjectSelect() {
    const root = useRootStore();
    const selected = root.projects.find(project => project.id === root.selectedProjectId);

    return (
        <MenuTrigger>
            <Button variant="bordered" className={ styles.trigger } aria-label="Project">
                <Folder />
                <Text bold truncate>{ selected?.name ?? 'No project' }</Text>
                <ChevronDown />
            </Button>
            <Popover placement="bottom start" width={ 280 }>
                <Menu
                    aria-label="Projects"
                    size="md"
                    onAction={ (key) => {
                        if (key === CREATE) openCreateProject(root);
                        else if (key === OPEN) void openExistingProject(root);
                        else root.selectProject(String(key));
                    } }
                >
                    { root.projects.map(project => (
                        <MenuItem
                            key={ project.id }
                            id={ project.id }
                            text={ project.name }
                            description={ project.path }
                            stacked
                            endAffix={ project.id === selected?.id ? <Check /> : undefined }
                        />
                    )) }
                    { root.projects.length > 0 && <MenuSeparator /> }
                    <MenuItem id={ CREATE } text="Create project" icon={ <Plus /> } />
                    <MenuItem id={ OPEN } text="Open existing project…" icon={ <Folder /> } />
                </Menu>
            </Popover>
        </MenuTrigger>
    );
}
