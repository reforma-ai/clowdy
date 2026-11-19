import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { ButtonUpload } from '@clowdy/components/ButtonUpload';
import { Input } from '@clowdy/components/Input';
import { Text } from '@clowdy/components/Text';
import { NO_PROJECT_ICON } from '@clowdy/protocol';
import { useEffect, useState } from 'react';

import { ProjectIcon } from '../../../shared/ProjectIcon';
import { useProjectIcon, useRootStore } from '../../../stores';
import { SettingsCard } from '../ui/SettingsCard';
import { SettingsRow } from '../ui/SettingsRow';
import { SettingsSection } from '../ui/SettingsSection';
import { removeProject, removeProjectIcon, renameProject, restoreFolderIcon, uploadProjectIcon } from './projectActions';
import { ProjectDefaults } from './ProjectDefaults';
import styles from './ProjectDetail.module.css';
import { ProjectFolders } from './ProjectFolders';

import type { Project, ProjectInfo } from '@clowdy/protocol';

export interface ProjectDetailProps {
    project: Project;
    info: ProjectInfo | undefined;
    /** The last read of `info` failed: what is shown may be out of date, or missing. */
    infoFailed: boolean;
}

/**
 * The blocks of the page of one project in Settings, which opens over the Projects page (its title and the line under it are the layer's,
 * in `ProjectsPage`): its name and icon, its folders with their git remotes, what new chats start with, and removing it. The personal space has its
 * folder and the new-chat settings only.
 */
export function ProjectDetail({ project, info, infoFailed }: ProjectDetailProps) {
    return (
        <>
            { !project.personal && (
                <SettingsSection title="Project">
                    <SettingsCard>
                        <NameRow project={ project } />
                        <IconRow project={ project } />
                    </SettingsCard>
                </SettingsSection>
            ) }

            <ProjectFolders project={ project } info={ info } infoFailed={ infoFailed } />

            <ProjectDefaults project={ project } />

            { !project.personal && <RemoveSection project={ project } info={ info } /> }
        </>
    );
}

/** Rename on blur or Enter; Escape puts the name back. The draft stays on screen until the daemon's own name arrives. */
function NameRow({ project }: { project: Project }) {
    const root = useRootStore();
    const [draft, setDraft] = useState<string>();

    // The daemon's answer, from this window or another one.
    useEffect(() => setDraft(undefined), [project.name]);

    const commit = async () => {
        const name = draft?.trim();

        if (!name || name === project.name) {
            setDraft(undefined);

            return;
        }

        if (!await renameProject(root, project, name)) setDraft(undefined);
    };

    return (
        <SettingsRow title="Name" description="How the project is listed in Clowdy">
            <Input
                type="text"
                variant="bordered"
                className={ styles.nameInput }
                aria-label="Project name"
                value={ draft ?? project.name }
                onChange={ setDraft }
                onBlur={ () => void commit() }
                onKeyDown={ (event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                    else if (event.key === 'Escape') setDraft(undefined);
                } }
            />
        </SettingsRow>
    );
}

/** The pictures an icon can be made of: whatever Chromium shows, an `.ico` and an SVG included. */
const ICON_FILES = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon,.ico,.svg';

/**
 * The picture the project shows in the menu and the list: upload one, remove it for the folder icon, and after a removal take the
 * favicon of the main folder back when it has one.
 */
function IconRow({ project }: { project: Project }) {
    const root = useRootStore();
    const shown = useProjectIcon(project);
    const found = root.projectIcons.foundIcon(project);
    const [uploading, setUploading] = useState(false);

    const upload = async (file: File) => {
        setUploading(true);

        try {
            await uploadProjectIcon(root, project, file);
        }
        finally {
            setUploading(false);
        }
    };

    return (
        <SettingsRow title="Icon" description="Shown in the project menu and the list. Clowdy uses the main folder's favicon until you upload another picture.">
            <Box direction="row" align="center" gap="sm">
                <span className={ styles.preview }><ProjectIcon project={ project } size={ 24 } /></span>
                <ButtonUpload variant="bordered" size="sm" accept={ ICON_FILES } isPending={ uploading } onFileSelect={ file => void upload(file) }>Upload…</ButtonUpload>
                { shown && <Button variant="bordered" size="sm" onPress={ () => void removeProjectIcon(root, project) }>Remove</Button> }
                { project.settings.icon === NO_PROJECT_ICON && found && <Button variant="bordered" size="sm" onPress={ () => void restoreFolderIcon(root, project) }>Use favicon</Button> }
            </Box>
        </SettingsRow>
    );
}

function RemoveSection({ project, info }: { project: Project; info: ProjectInfo | undefined }) {
    const root = useRootStore();
    const working = (info?.activeRuns ?? 0) > 0;
    const stays = project.folders.length === 1 ? 'The folder and its files stay' : 'Its folders and their files stay';

    return (
        <SettingsSection title="Danger zone">
            <SettingsCard>
                <SettingsRow
                    title="Remove project"
                    description={ `Deletes ${ project.name }'s chats, tasks and the work of its agents from Clowdy. ${ stays } on your computer.` }
                    footer={ working && <Text variant="sm" color="warning" role="status">Agents are working in this project. Stop them first.</Text> }
                >
                    <Button color="danger" isDisabled={ working } onPress={ () => removeProject(root, project, info) }>Remove project</Button>
                </SettingsRow>
            </SettingsCard>
        </SettingsSection>
    );
}
