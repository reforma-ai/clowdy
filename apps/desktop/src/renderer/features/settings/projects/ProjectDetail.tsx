import { Button } from '@clowdy/components/Button';
import { Input } from '@clowdy/components/Input';
import { Text } from '@clowdy/components/Text';
import { ArrowUpRight } from '@clowdy/icons/14';
import { useEffect, useState } from 'react';

import { useRootStore } from '../../../stores';
import { SettingsCard } from '../ui/SettingsCard';
import { SettingsPage } from '../ui/SettingsPage';
import { SettingsRow } from '../ui/SettingsRow';
import { SettingsSection } from '../ui/SettingsSection';
import { removeProject, renameProject } from './projectActions';
import { ProjectDefaults } from './ProjectDefaults';
import styles from './ProjectDetail.module.css';
import { ProjectFolder } from './ProjectFolder';
import { holdingsLine, remoteLink } from './projectView';

import type { Project, ProjectInfo } from '@clowdy/protocol';

export interface ProjectDetailProps {
    project: Project;
    info: ProjectInfo | undefined;
    /** The last read of `info` failed: what is shown may be out of date, or missing. */
    infoFailed: boolean;
    onBack: () => void;
}

const PERSONAL_NOTE = 'Your personal space is for chats that belong to no repository. It lives in Clowdy\'s own folder, and it cannot be renamed, moved or removed.';

/**
 * The page of one project in Settings, under the Projects page: its name and folder, git remote, what new chats start with, and removing it.
 * The personal space has the folder and the new-chat settings only.
 */
export function ProjectDetail({ project, info, infoFailed, onBack }: ProjectDetailProps) {
    return (
        <SettingsPage
            title={ project.name }
            parents={ [{ label: 'Projects', onPress: onBack }] }
            description={ project.personal ? PERSONAL_NOTE : holdingsLine(info) }
        >
            <SettingsSection title="Project">
                <SettingsCard divided>
                    { !project.personal && <NameRow project={ project } /> }
                    <ProjectFolder project={ project } info={ info } />
                </SettingsCard>
            </SettingsSection>

            { !project.personal && <GitSection info={ info } failed={ infoFailed } /> }

            <ProjectDefaults project={ project } />

            { !project.personal && <RemoveSection project={ project } info={ info } /> }
        </SettingsPage>
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
        <SettingsRow title="Name" description="How the project is listed in Clowdy.">
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

function GitSection({ info, failed }: { info: ProjectInfo | undefined; failed: boolean }) {
    const remote = remoteLink(info?.remoteUrl);

    return (
        <SettingsSection title="Git">
            <SettingsCard divided>
                { !info && <SettingsRow title="Repository" description={ failed ? 'The repository could not be read.' : 'Reading the repository…' } /> }
                { info && !remote && (
                    <SettingsRow title="Remote" description={ info.folderExists ? 'This repository has no origin remote.' : 'The folder is missing, so there is nothing to read.' } />
                ) }
                { remote && (
                    <SettingsRow title="Remote">
                        { remote.href
                            ? <Button variant="filled" color="secondary" size="sm" href={ remote.href } target="_blank" rel="noreferrer" className={ styles.value }>{ remote.text }<ArrowUpRight /></Button>
                            : <Text className={ styles.value }>{ remote.text }</Text> }
                    </SettingsRow>
                ) }
            </SettingsCard>
        </SettingsSection>
    );
}

function RemoveSection({ project, info }: { project: Project; info: ProjectInfo | undefined }) {
    const root = useRootStore();
    const working = (info?.activeRuns ?? 0) > 0;

    return (
        <SettingsSection title="Danger zone">
            <SettingsCard>
                <SettingsRow
                    title="Remove project"
                    description={ `Deletes ${ project.name }'s chats, tasks and the work of its agents from Clowdy. The folder and its files stay on your computer.` }
                    footer={ working && <Text variant="sm" color="warning" role="status">Agents are working in this project. Stop them first.</Text> }
                >
                    <Button color="danger" isDisabled={ working } onPress={ () => removeProject(root, project, info) }>Remove project</Button>
                </SettingsRow>
            </SettingsCard>
        </SettingsSection>
    );
}
