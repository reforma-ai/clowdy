import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { AddFolder, Check, ChevronDown, Folder, Home, Sliders } from '@clowdy/icons/14';
import { mainFolder } from '@clowdy/protocol';

import { PathText } from '../shared/PathText';
import { ProjectIcon } from '../shared/ProjectIcon';
import { useRootStore } from '../stores';
import { openAddProject } from './projectDialogs';
import styles from './ProjectSelect.module.css';

import type { Project } from '@clowdy/protocol';

const ADD = 'add-project';
const MANAGE = 'manage-projects';

/** Where a project is: its main folder (the path gives way to the count), and `+N` for the folders it has besides. */
function Where({ project }: { project: Pick<Project, 'folders'> }) {
    const more = project.folders.length - 1;

    return (
        <span className={ styles.where }>
            <PathText path={ mainFolder(project).path } />
            { more > 0 && <span className={ styles.more }>{ `+${ more }` }</span> }
        </span>
    );
}

/**
 * The project switcher in the title band: the personal space on top, then the projects in the person's order, then "Add project…" and
 * "Manage projects…", which opens Settings > Projects. The menu only switches; everything else about a project is managed there.
 */
export function ProjectSelect() {
    const root = useRootStore();
    const selected = root.projects.find(project => project.id === root.selectedProjectId);
    const personal = root.projects.find(project => project.personal);
    const own = root.projects.filter(project => !project.personal);
    const check = (id: string) => (id === selected?.id ? <Check /> : undefined);

    return (
        <MenuTrigger>
            <Button variant="bordered" className={ styles.trigger } aria-label="Project">
                { selected ? <ProjectIcon project={ selected } /> : <Folder /> }
                <Text weight="medium" truncate>{ selected?.name ?? 'No project' }</Text>
                <ChevronDown />
            </Button>
            <Popover placement="bottom start" width={ 280 }>
                <Menu
                    aria-label="Projects"
                    size="md"
                    onAction={ (key) => {
                        if (key === ADD) openAddProject(root);
                        else if (key === MANAGE) root.ui.openProjectSettings();
                        else root.selectProject(String(key));
                    } }
                >
                    { personal && <MenuItem id={ personal.id } text={ personal.name } description="Chats without a project" icon={ <Home /> } stacked data-align="center" endAffix={ check(personal.id) } /> }
                    { personal && own.length > 0 && <MenuSeparator /> }
                    { own.map(project => (
                        <MenuItem
                            key={ project.id }
                            id={ project.id }
                            text={ project.name }
                            description={ <Where project={ project } /> }
                            icon={ <ProjectIcon project={ project } /> }
                            stacked
                            data-align="center"
                            endAffix={ check(project.id) }
                        />
                    )) }
                    { root.projects.length > 0 && <MenuSeparator /> }
                    <MenuItem id={ ADD } text="Add project…" icon={ <AddFolder /> } />
                    <MenuItem id={ MANAGE } text="Manage projects…" icon={ <Sliders /> } />
                </Menu>
            </Popover>
        </MenuTrigger>
    );
}
