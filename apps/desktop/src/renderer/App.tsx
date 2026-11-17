import { ToastRegion } from '@clowdy/components/Toast';

import { root } from './root';
import { Shell } from './shell/Shell';
import { RootStoreProvider } from './stores';

export function App() {
    return (
        <RootStoreProvider value={ root }>
            <Shell />
            <ToastRegion />
        </RootStoreProvider>
    );
}
