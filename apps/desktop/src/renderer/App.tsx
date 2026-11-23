import { ToastRegion } from '@clowdy/components/Toast';
import { useEffect } from 'react';

import { root } from './root';
import { Shell } from './shell/Shell';
import { RootStoreProvider } from './stores';

export function App() {
    // After the first render: an update on its first launch that never gets here is rolled back.
    useEffect(() => void window.desktop?.ready(), []);

    return (
        <RootStoreProvider value={root}>
            <Shell />
            <ToastRegion />
        </RootStoreProvider>
    );
}
