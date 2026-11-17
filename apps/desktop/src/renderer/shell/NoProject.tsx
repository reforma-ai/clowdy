import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';

import { useRootStore } from '../stores';
import styles from './Message.module.css';
import { openCreateProject, openExistingProject } from './projectDialogs';

/** The empty state for a window without a project. */
export function NoProject() {
    const root = useRootStore();

    return (
        <div className={ styles.message }>
            <Text variant="heading-2">Create or open a project</Text>
            <Text color="secondary">
                A project is a folder with your code. Its chats, tasks and agents live here, and the agents make their changes directly in that folder.
            </Text>
            <div className={ styles.actions }>
                <Button color="primary" onPress={ () => openCreateProject(root) }>Create project</Button>
                <Button variant="bordered" onPress={ () => void openExistingProject(root) }>Open existing project…</Button>
            </div>
        </div>
    );
}
