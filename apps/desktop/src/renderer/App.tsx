import { Text } from '@clowdy/components/Text';

import styles from './App.module.css';

/** The empty shell. The workspace (projects, chats, tasks, agents, documents) grows from here. */
export function App() {
    return (
        <main className={ styles.root }>
            <Text variant="heading-2" color="secondary">Clowdy</Text>
        </main>
    );
}
