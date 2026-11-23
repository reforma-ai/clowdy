import { Button } from '@clowdy/components/Button';
import { Input } from '@clowdy/components/Input';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { Close } from '@clowdy/icons/12';
import { NO_PROJECT_ICON } from '@clowdy/protocol';
import { useEffect, useRef, useState } from 'react';

import { ProjectIcon } from '../../../shared/ProjectIcon';
import { useProjectIcon, useRootStore } from '../../../stores';
import { SettingsCard } from '../ui/SettingsCard';
import { SettingsRow } from '../ui/SettingsRow';
import { SettingsSection } from '../ui/SettingsSection';
import { ProjectDefaults } from './ProjectDefaults';
import styles from './ProjectDetail.module.css';
import { ProjectFolders } from './ProjectFolders';
import { ProjectWorktrees } from './ProjectWorktrees';
import {
    removeProject,
    removeProjectIcon,
    renameProject,
    restoreFolderIcon,
    uploadProjectIcon,
} from './projectActions';

import type { Project, ProjectInfo } from '@clowdy/protocol';

export interface ProjectDetailProps {
    project: Project;
    info: ProjectInfo | undefined;
    /** The last read of `info` failed: what is shown may be out of date, or missing. */
    infoFailed: boolean;
}

/**
 * The blocks of the page of one project in Settings, which opens over the Projects page (its title and the line under it are the layer's,
 * in `ProjectsPage`): its name and icon, its folders with their git remotes, the button of its worktrees, what new chats start with, and removing it. The personal space has its
 * folder and the new-chat settings only.
 */
export function ProjectDetail({ project, info, infoFailed }: ProjectDetailProps) {
    return (
        <>
            {!project.personal && (
                <SettingsSection title="Project">
                    <SettingsCard>
                        <NameRow project={project} />
                    </SettingsCard>
                </SettingsSection>
            )}

            <ProjectFolders project={project} info={info} infoFailed={infoFailed} />

            <ProjectWorktrees project={project} />

            <ProjectDefaults project={project} />

            {!project.personal && <RemoveSection project={project} info={info} />}
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

        if (!(await renameProject(root, project, name))) setDraft(undefined);
    };

    return (
        <SettingsRow title="Name" description="How the project is listed in Clowdy">
            <Input
                type="text"
                variant="bordered"
                className={styles.nameField}
                aria-label="Project name"
                value={draft ?? project.name}
                onChange={setDraft}
                onBlur={() => void commit()}
                onKeyDown={event => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                    else if (event.key === 'Escape') setDraft(undefined);
                }}
            >
                <IconField slot="prefix" project={project} />
            </Input>
        </SettingsRow>
    );
}

/** The pictures an icon can be made of: whatever Chromium shows, an `.ico` and an SVG included. */
const ICON_FILES = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon,.ico,.svg';

/**
 * The project's icon, the whole left side of the name field. A press picks a picture. While a picture shows (uploaded, or the main folder's
 * favicon), hovering shows a cross: an uploaded picture clears back to the favicon, and the favicon itself hides for the folder icon.
 */
function IconField({ project, slot }: { project: Project; slot?: string }) {
    const root = useRootStore();
    const file = useRef<HTMLInputElement>(null);
    const shown = useProjectIcon(project);
    const custom = project.settings.icon != null && project.settings.icon !== NO_PROJECT_ICON;
    const [uploading, setUploading] = useState(false);

    const upload = async (picked: File) => {
        setUploading(true);

        try {
            await uploadProjectIcon(root, project, picked);
        } finally {
            setUploading(false);
        }
    };

    return (
        <span slot={slot} className={styles.iconSlot} onClick={event => event.stopPropagation()}>
            <input
                ref={file}
                type="file"
                accept={ICON_FILES}
                className={styles.file}
                aria-label="Project icon file"
                onChange={() => {
                    const picked = file.current?.files?.[0];

                    if (!picked || !file.current) return;

                    file.current.value = '';
                    void upload(picked);
                }}
            />
            <button
                type="button"
                className={styles.choose}
                aria-label="Choose icon"
                disabled={uploading}
                onClick={() => file.current?.click()}
            >
                {uploading ? <Spinner size="xs" /> : <ProjectIcon project={project} size={20} />}
            </button>
            {shown && !uploading && (
                <button
                    type="button"
                    className={styles.reset}
                    aria-label="Reset icon"
                    onClick={event => {
                        event.stopPropagation();
                        void (custom ? restoreFolderIcon(root, project) : removeProjectIcon(root, project));
                    }}
                >
                    <Close width={8} height={8} />
                </button>
            )}
        </span>
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
                    description={`Deletes ${project.name}'s chats, tasks and the work of its agents from Clowdy. ${stays} on your computer.`}
                    footer={
                        working && (
                            <Text variant="sm" color="warning" role="status">
                                Agents are working in this project. Stop them first.
                            </Text>
                        )
                    }
                >
                    <Button color="danger" isDisabled={working} onPress={() => removeProject(root, project, info)}>
                        Remove project
                    </Button>
                </SettingsRow>
            </SettingsCard>
        </SettingsSection>
    );
}
