import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { SortableList } from '@clowdy/components/SortableList';
import { Folder, Plus } from '@clowdy/icons/14';
import { useMemo } from 'react';

import { openCreateProject, openExistingProject } from '../../../shell/projectDialogs';
import { useRootStore } from '../../../stores';
import { SettingsEmpty } from '../ui/SettingsEmpty';
import { SettingsPage } from '../ui/SettingsPage';
import { openProject, removeProject, reorderProjects } from './projectActions';
import { ProjectDetail } from './ProjectDetail';
import { ProjectRow } from './ProjectRow';
import styles from './ProjectsPage.module.css';
import { projectNote } from './projectView';
import { useProjectsInfo } from './useProjectsInfo';

const CREATE = 'create';
const OPEN = 'open';

/**
 * Settings > Projects: the personal space, pinned, and the person's projects, which a grip drags into the order of the project menu. A row
 * opens the page of that project over the list, which stays under it as it was, until the link back in the path of the title is used.
 */
export function ProjectsPage() {
    const root = useRootStore();
    const { info, failed } = useProjectsInfo();
    const selected = root.ui.settingsProjectId ? root.projects.find(project => project.id === root.ui.settingsProjectId) : undefined;
    const personal = root.projects.find(project => project.personal);
    const own = useMemo(() => root.projects.filter(project => !project.personal), [root.projects]);

    return (
        <SettingsPage
            title="Projects"
            description="The folders Clowdy can work in. Your personal space is always first. Drag a project to change the order of the project menu."
            layers={ selected
                ? [{
                    id: selected.id,
                    title: selected.name,
                    description: projectNote(selected, info.get(selected.id)),
                    content: <ProjectDetail project={ selected } info={ info.get(selected.id) } infoFailed={ failed } />,
                }]
                : [] }
            onNavigate={ () => root.ui.openProjectSettings() }
            actions={ selected ? undefined : (
                <MenuTrigger>
                    <Button variant="filled" color="contrast" size="sm"><Plus />Add project</Button>
                    <Popover placement="bottom end" width={ 240 }>
                        <Menu
                            aria-label="Add a project"
                            size="md"
                            onAction={ (key) => {
                                if (key === CREATE) openCreateProject(root);
                                else if (key === OPEN) void openExistingProject(root);
                            } }
                        >
                            <MenuItem id={ CREATE } text="Create project" icon={ <Plus /> } />
                            <MenuItem id={ OPEN } text="Open existing project…" icon={ <Folder /> } />
                        </Menu>
                    </Popover>
                </MenuTrigger>
            ) }
        >
            <div className={ styles.list }>
                { personal && (
                    <ProjectRow
                        project={ personal }
                        info={ info.get(personal.id) }
                        onManage={ () => root.ui.openProjectSettings(personal.id) }
                        onOpen={ () => openProject(root, personal) }
                    />
                ) }

                { own.length === 0
                    ? <SettingsEmpty>No projects yet. Create one, or open a folder you already work in.</SettingsEmpty>
                    : (
                        <SortableList
                            aria-label="Projects"
                            items={ own }
                            getKey={ project => project.id }
                            getTextValue={ project => project.name }
                            getDragHandleOptions={ () => ({ variant: 'surface', edgeOffset: '10' }) }
                            onChange={ projects => void reorderProjects(root, projects) }
                        >
                            { project => (
                                <ProjectRow
                                    project={ project }
                                    info={ info.get(project.id) }
                                    onManage={ () => root.ui.openProjectSettings(project.id) }
                                    onOpen={ () => openProject(root, project) }
                                    onRemove={ () => removeProject(root, project, info.get(project.id)) }
                                />
                            ) }
                        </SortableList>
                    ) }
            </div>
        </SettingsPage>
    );
}
