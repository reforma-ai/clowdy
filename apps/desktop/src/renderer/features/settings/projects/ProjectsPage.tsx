import { Button } from '@clowdy/components/Button';
import { SortableList } from '@clowdy/components/SortableList';
import { Plus } from '@clowdy/icons/14';
import { useMemo } from 'react';

import { openAddProject } from '../../../shell/projectDialogs';
import { useRootStore } from '../../../stores';
import { SettingsEmpty } from '../ui/SettingsEmpty';
import { SettingsPage } from '../ui/SettingsPage';
import { openProject, removeProject, reorderProjects } from './projectActions';
import { ProjectDetail } from './ProjectDetail';
import { ProjectRow } from './ProjectRow';
import styles from './ProjectsPage.module.css';
import { projectNote } from './projectView';
import { useProjectsInfo } from './useProjectsInfo';

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
            description="A project can hold several folders, so keep the repos that belong together in one"
            layers={ selected
                ? [{
                    id: selected.id,
                    title: selected.name,
                    description: projectNote(selected, info.get(selected.id)),
                    content: <ProjectDetail project={ selected } info={ info.get(selected.id) } infoFailed={ failed } />,
                }]
                : [] }
            onNavigate={ () => root.ui.openProjectSettings() }
            actions={ selected ? undefined : <Button variant="filled" color="contrast" size="sm" onPress={ () => openAddProject(root) }><Plus />Add project…</Button> }
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
                    ? <SettingsEmpty>No projects yet. Add the folders you work in, or start one in a new folder.</SettingsEmpty>
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
