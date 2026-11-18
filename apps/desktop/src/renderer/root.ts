import { toast } from '@clowdy/components/Toast';

import { createTransport, resolveDaemonConfig } from './daemon/config';
import { HttpTransport } from './daemon/httpTransport';
import { RootStore, type Notice } from './stores/RootStore';
import { initialUiFromSearch } from './stores/UiStore';

const TOAST_KIND = { info: 'info', warn: 'warning', error: 'error' } as const;

function showNotice({ level, text }: Notice): void {
    toast[TOAST_KIND[level]]({ message: text });
}

const config = resolveDaemonConfig(location.search, window.desktop?.daemon);

const transport = createTransport(config);

// A daemon that was replaced listens elsewhere: the transport follows it and its feed resumes where it was.
const stopFollowing = transport instanceof HttpTransport ? window.desktop?.onDaemonChange(address => transport.setAddress(address)) : undefined;

/** The app's one store. It starts loading when the module is first imported. */
export const root = new RootStore(transport, {
    notify: showNotice,
    initialUi: config.kind === 'fixtures' ? initialUiFromSearch(location.search) : undefined,
});

void root.load();

if (import.meta.env.DEV) {
    // For the console and for scripted checks: `__clowdy.root.projects`, `__clowdy.root.handleFeedStatus('reconnecting')`.
    (window as Window & { __clowdy?: unknown }).__clowdy = { root };
}

// A replaced module must not leave its event feed open next to the new one.
import.meta.hot?.dispose(() => {
    stopFollowing?.();
    root.dispose();
});
