import { Alert, AlertAction, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { AttentionTriangle } from '@clowdy/icons/14';
import { mainFolder } from '@clowdy/protocol';

import { useRootStore } from '../../../stores';
import { SettingsRow } from '../ui/SettingsRow';
import { changeFolder } from './projectActions';
import styles from './ProjectDetail.module.css';

import type { Project, ProjectInfo } from '@clowdy/protocol';

/** Where the project is on disk. A project that moved is pointed at its new place here; the personal space stays where Clowdy keeps it. */
export function ProjectFolder({ project, info }: { project: Project; info: ProjectInfo | undefined }) {
    const root = useRootStore();
    const missing = info?.folders[0]?.exists === false;
    const working = (info?.activeRuns ?? 0) > 0;
    const change = () => void changeFolder(root, project);
    const footer = (
        <>
            { missing && (
                <Alert color="warning" role="status">
                    <AlertIcon><AttentionTriangle /></AlertIcon>
                    <AlertDescription>
                        This folder no longer exists, so the agents of this project cannot work. If it moved, choose its new place.
                    </AlertDescription>
                    { !project.personal && <AlertAction><Button size="sm" variant="bordered" isDisabled={ working } onPress={ change }>Choose folder…</Button></AlertAction> }
                </Alert>
            ) }
            { working && !project.personal && <Text variant="sm" color="secondary" role="status">Agents are working in this project. Stop them before changing the folder.</Text> }
        </>
    );

    return (
        <SettingsRow title="Folder" description={ <span className={ styles.value }>{ mainFolder(project).path }</span> } footer={ (missing || (working && !project.personal)) && footer }>
            { !project.personal && <Button variant="bordered" size="sm" isDisabled={ working } onPress={ change }>Change folder…</Button> }
        </SettingsRow>
    );
}
