import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { Check, ChevronDown, Folder, Home, Plus, Sliders } from '@clowdy/icons/14';

import { useRootStore } from '../stores';
import { openCreateProject, openExistingProject } from './projectDialogs';
import styles from './ProjectSelect.module.css';

const CREATE = 'create-project';
const OPEN = 'open-project';
const MANAGE = 'manage-projects';

/**
 * The project switcher in the title band: the personal space on top, then the projects in the person's order, then "Create project",
 * "Open existing project…" and "Manage projects…", which opens Settings > Projects. The menu only switches; everything else about a project is managed there.
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
                { selected?.personal ? <Home /> : <Folder /> }
                <Text weight="medium" truncate>{ selected?.name ?? 'No project' }</Text>
                <ChevronDown />
            </Button>
            <Popover placement="bottom start" width={ 280 }>
                <Menu
                    aria-label="Projects"
                    size="md"
                    onAction={ (key) => {
                        if (key === CREATE) openCreateProject(root);
                        else if (key === OPEN) void openExistingProject(root);
                        else if (key === MANAGE) root.ui.openProjectSettings();
                        else root.selectProject(String(key));
                    } }
                >
                    { personal && <MenuItem id={ personal.id } text={ personal.name } description="Chats without a project" icon={ <Home /> } stacked endAffix={ check(personal.id) } /> }
                    { personal && own.length > 0 && <MenuSeparator /> }
                    { own.map(project => (
                        <MenuItem
                            key={ project.id }
                            id={ project.id }
                            text={ project.name }
                            description={ project.path }
                            stacked
                            endAffix={ check(project.id) }
                        />
                    )) }
                    { root.projects.length > 0 && <MenuSeparator /> }
                    <MenuItem id={ CREATE } text="Create project" icon={ <Plus /> } />
                    <MenuItem id={ OPEN } text="Open existing project…" icon={ <Folder /> } />
                    <MenuSeparator />
                    <MenuItem id={ MANAGE } text="Manage projects…" icon={ <Sliders /> } />
                </Menu>
            </Popover>
        </MenuTrigger>
    );
}
