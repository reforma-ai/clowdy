import { FileIconColorScheme } from '@clowdy/components/FileIcon';
import { ToastRegion } from '@clowdy/components/Toast';
import { useEffect } from 'react';

import { root } from './root';
import { useColorScheme } from './shared/useColorScheme';
import { Shell } from './shell/Shell';
import { RootStoreProvider } from './stores';

export function App() {
    const scheme = useColorScheme();

    // After the first render: an update on its first launch that never gets here is rolled back.
    useEffect(() => void window.desktop?.ready(), []);

    return (
        <RootStoreProvider value={root}>
            <FileIconColorScheme value={scheme}>
                <Shell />
                <ToastRegion />
            </FileIconColorScheme>
        </RootStoreProvider>
    );
}
