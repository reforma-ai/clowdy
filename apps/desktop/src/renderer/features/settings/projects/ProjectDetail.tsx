import { Button } from '@clowdy/components/Button';
import { Input } from '@clowdy/components/Input';
import { Badge } from '@clowdy/components/Tag';
import { Text } from '@clowdy/components/Text';
import { ArrowUpRight, ChevronLeft, Folder, Home } from '@clowdy/icons/14';
import { useEffect, useState } from 'react';

import { useRootStore } from '../../../stores';
import { removeProject, renameProject } from './projectActions';
import { ProjectDefaults } from './ProjectDefaults';
import styles from './ProjectDetail.module.css';
import { ProjectFolder } from './ProjectFolder';
import section from './ProjectSection.module.css';
import { holdingsLine, remoteLink } from './projectView';

import type { Project, ProjectInfo } from '@clowdy/protocol';

export interface ProjectDetailProps {
    project: Project;
    info: ProjectInfo | undefined;
    /** The last read of `info` failed: what is shown may be out of date, or missing. */
    infoFailed: boolean;
    onBack: () => void;
}

/** The page of one project in Settings: its name, folder, git remote, what new chats start with, and removing it. The personal space has the last of these only for new chats. */
export function ProjectDetail({ project, info, infoFailed, onBack }: ProjectDetailProps) {
    const holdings = holdingsLine(info);

    return (
        <>
            <Button variant="inline" color="secondary" size="sm" className={ styles.back } onPress={ onBack }><ChevronLeft />Projects</Button>

            <header className={ styles.header }>
                <div className={ styles.title }>
                    { project.personal ? <Home /> : <Folder /> }
                    <Text variant="heading-3">{ project.name }</Text>
                </div>
                { holdings && <Text color="secondary">{ holdings }</Text> }
            </header>

            { project.personal
                ? <Text color="secondary" className={ styles.note }>Your personal space is for chats that belong to no repository. It lives in Clowdy&apos;s own folder, and it cannot be renamed, moved or removed.</Text>
                : <NameSection project={ project } /> }

            <ProjectFolder project={ project } info={ info } />

            { !project.personal && <GitSection info={ info } failed={ infoFailed } /> }

            <ProjectDefaults project={ project } />

            { !project.personal && <RemoveSection project={ project } info={ info } /> }
        </>
    );
}

/** Rename on blur or Enter; Escape puts the name back. The draft stays on screen until the daemon's own name arrives. */
function NameSection({ project }: { project: Project }) {
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
        <section className={ section.section } aria-label="Name">
            <Text variant="heading-5">Name</Text>
            <Input
                type="text"
                variant="bordered"
                aria-label="Project name"
                value={ draft ?? project.name }
                onChange={ setDraft }
                onBlur={ () => void commit() }
                onKeyDown={ (event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                    else if (event.key === 'Escape') setDraft(undefined);
                } }
            />
        </section>
    );
}

function GitSection({ info, failed }: { info: ProjectInfo | undefined; failed: boolean }) {
    const remote = remoteLink(info?.remoteUrl);

    return (
        <section className={ section.section } aria-label="Git">
            <Text variant="heading-5">Git</Text>
            <div className={ section.card }>
                { !info && <Text color="secondary">{ failed ? 'The repository could not be read.' : 'Reading the repository…' }</Text> }
                { info && !remote && <Text color="secondary">{ info.folderExists ? 'This repository has no origin remote.' : 'The folder is missing, so there is nothing to read.' }</Text> }
                { remote && (
                    <div className={ section.field }>
                        <Text variant="sm" color="secondary">Remote</Text>
                        { remote.href
                            ? <Button variant="inline" size="sm" href={ remote.href } target="_blank" rel="noreferrer" className={ section.path }>{ remote.text }<ArrowUpRight /></Button>
                            : <Text className={ section.path }>{ remote.text }</Text> }
                    </div>
                ) }
                { info?.branch && (
                    <div className={ section.field }>
                        <Text variant="sm" color="secondary">Branch</Text>
                        <Text>{ info.branch }</Text>
                    </div>
                ) }
            </div>
        </section>
    );
}

function RemoveSection({ project, info }: { project: Project; info: ProjectInfo | undefined }) {
    const root = useRootStore();
    const working = (info?.activeRuns ?? 0) > 0;

    return (
        <section className={ section.section } aria-label="Danger zone">
            <Text variant="heading-5">Danger zone</Text>
            <div className={ section.card }>
                <Text color="secondary">
                    Removing { project.name } deletes its chats, tasks and the work of its agents from Clowdy. The folder and its files stay on your computer.
                </Text>
                { working && <Text color="warning" role="status">Agents are working in this project. Stop them first.</Text> }
                <div>
                    <Button color="danger" isDisabled={ working } onPress={ () => removeProject(root, project, info) }>Remove project</Button>
                </div>
            </div>
        </section>
    );
}
