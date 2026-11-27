import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';

import { useRootStore } from '../stores';
import styles from './Message.module.css';
import { openAddProject } from './projectDialogs';

/** The empty state for a window without a project. */
export function NoProject() {
    const root = useRootStore();

    return (
        <div className={styles.message}>
            <Text variant="heading-2">Add a space</Text>
            <Text color="secondary">
                A space is one or more folders with your code, or a new folder to start in. Its chats, tasks and agents
                live here, and the agents make their changes directly in those folders.
            </Text>
            <div className={styles.actions}>
                <Button color="primary" onPress={() => openAddProject(root)}>
                    Add space…
                </Button>
            </div>
        </div>
    );
}
