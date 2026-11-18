import { Alert, AlertAction, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { AttentionTriangle } from '@clowdy/icons/14';

import { useRootStore } from '../../../stores';
import { changeFolder } from './projectActions';
import section from './ProjectSection.module.css';

import type { Project, ProjectInfo } from '@clowdy/protocol';

/** Where the project is on disk. A project that moved is pointed at its new place here; the personal space stays where Clowdy keeps it. */
export function ProjectFolder({ project, info }: { project: Project; info: ProjectInfo | undefined }) {
    const root = useRootStore();
    const missing = info !== undefined && !info.folderExists;
    const working = (info?.activeRuns ?? 0) > 0;

    return (
        <section className={ section.section } aria-label="Folder">
            <Text variant="heading-5">Folder</Text>
            <div className={ section.card }>
                <div className={ section.line }>
                    <Text className={ `${ section.grow } ${ section.path }` }>{ project.path }</Text>
                    { !project.personal && (
                        <Button variant="bordered" size="sm" isDisabled={ working } onPress={ () => void changeFolder(root, project) }>Change folder…</Button>
                    ) }
                </div>
                { missing && (
                    <Alert color="warning" role="status">
                        <AlertIcon><AttentionTriangle /></AlertIcon>
                        <AlertDescription>
                            This folder no longer exists, so the agents of this project cannot work. If it moved, choose its new place.
                        </AlertDescription>
                        { !project.personal && <AlertAction><Button size="sm" variant="bordered" isDisabled={ working } onPress={ () => void changeFolder(root, project) }>Choose folder…</Button></AlertAction> }
                    </Alert>
                ) }
                { working && !project.personal && <Text variant="sm" color="secondary" role="status">Agents are working in this project. Stop them before changing the folder.</Text> }
            </div>
        </section>
    );
}
