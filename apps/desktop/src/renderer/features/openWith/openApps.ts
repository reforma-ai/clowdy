import { toast } from '@clowdy/components/Toast';
import { useEffect, useState } from 'react';

import { openWithPreferences } from './openWithPreferences';

import type { OpenApp, OpenApps, OpenPathApp } from '../../../shared/bridge';
import type { OpenEffects, OpenPrograms } from './openTarget';

const NONE: OpenApps = { editors: [], terminals: [], fileManagers: [] };

/** The program a preference names, or the first one the computer has when the choice is not made, or its program is gone. */
export function chosenApp(apps: readonly OpenApp[], id: string | undefined): OpenApp | undefined {
    return apps.find(app => app.id === id) ?? apps[0];
}

/** The editor, the terminal and the file manager that open a path: the ones Settings > Files names, else the first of each the computer has. */
export function chosenPrograms(apps: OpenApps): OpenPrograms {
    return {
        fileManager: chosenApp(apps.fileManagers, openWithPreferences.fileManager),
        editor: chosenApp(apps.editors, openWithPreferences.editor),
        terminal: chosenApp(apps.terminals, openWithPreferences.terminal),
    };
}

/** Whether this window can open a folder or a file in another program: only the desktop app can; a page in a browser cannot. */
export const canOpenPaths = () => window.desktop?.openPath !== undefined;

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
            found => {
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

/** Opens a folder or a file in a program of the computer. What goes wrong (the path is gone, the program will not start) is a toast. */
async function openPathIn(path: string, kind: OpenPathApp['kind'], app: OpenApp): Promise<void> {
    try {
        await window.desktop?.openPath(path, { kind, id: app.id });
    } catch {
        toast.error({ message: `Couldn't open it in ${app.name}` });
    }
}

/** What the menu's actions do in the app: a program is started by the desktop app, a link goes to the browser (the main process opens https addresses outside), a copy says so. */
export const openEffects: OpenEffects = {
    openPath: (path, kind, app) => void openPathIn(path, kind, app),
    openUrl: url => {
        window.open(url, '_blank', 'noopener');
    },
    copy: text => {
        navigator.clipboard.writeText(text).then(
            () => toast.success({ message: 'Path copied' }),
            () => toast.error({ message: "Couldn't copy the path" })
        );
    },
};
