import { useState } from 'react';

import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { startChat } from './commands';

/** Starts an empty chat in the selected project and shows it; `isCreating` is true until the daemon has answered. */
export function useStartChat(): { start: () => Promise<void>; isCreating: boolean } {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const [isCreating, setIsCreating] = useState(false);

    const start = async () => {
        setIsCreating(true);
        await startChat(root, project.id, ui);
        setIsCreating(false);
    };

    return { start, isCreating };
}
