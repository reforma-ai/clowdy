import { useSyncExternalStore } from 'react';

type ColorScheme = 'light' | 'dark';

/** The theme module puts `.dark` on `<html>` (the window's own choice or the OS appearance), so the class is what the page looks like. */
function subscribe(onChange: () => void): () => void {
    const observer = new MutationObserver(onChange);

    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => observer.disconnect();
}

const read = (): ColorScheme => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');

/** The scheme the window is drawn in now, for what has to pick its pictures by it. */
export function useColorScheme(): ColorScheme {
    return useSyncExternalStore(subscribe, read);
}
