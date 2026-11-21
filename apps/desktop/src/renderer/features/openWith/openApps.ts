import { toast } from '@clowdy/components/Toast';
import { useEffect, useState } from 'react';

import type { OpenApp, OpenApps, OpenFolderApp } from '../../../shared/bridge';

const NONE: OpenApps = { editors: [], terminals: [], fileManagers: [] };

/** The program a preference names, or the first one the computer has when the choice is not made, or its program is gone. */
export function chosenApp(apps: readonly OpenApp[], id: string | undefined): OpenApp | undefined {
    return apps.find(app => app.id === id) ?? apps[0];
}

/** Whether this window can open a folder in another program: only the desktop app can; a page in a browser cannot. */
export const canOpenFolders = () => window.desktop?.openFolder !== undefined;

/**
 * The editors, terminals and file managers this computer has, read from the desktop app each time the component that asks is drawn first (a program may
 * have been installed since). Nothing until the answer comes, and nothing at all in a page that is not the desktop app.
 */
export function useOpenApps(): OpenApps {
    const [apps, setApps] = useState<OpenApps>(NONE);

    useEffect(() => {
        if (!window.desktop?.getOpenApps) return;

        let isCurrent = true;

        window.desktop.getOpenApps().then(
            (found) => {
                if (isCurrent) setApps(found);
            },
            () => undefined
        );

        return () => {
            isCurrent = false;
        };
    }, []);

    return apps;
}

/** Opens a folder in a program of the computer. What goes wrong (the folder is gone, the program will not start) is a toast. */
export async function openFolderIn(folder: string, kind: OpenFolderApp['kind'], app: OpenApp): Promise<void> {
    try {
        await window.desktop?.openFolder(folder, { kind, id: app.id });
    }
    catch {
        toast.error({ message: `Couldn't open the folder in ${ app.name }` });
    }
}
