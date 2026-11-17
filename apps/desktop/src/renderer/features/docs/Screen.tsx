import { useEffect } from 'react';

import { DocsMain } from './DocsMain';
import { DocsSidebar } from './DocsSidebar';
import styles from './Screen.module.css';
import { useDocsStore } from './useDocsStore';

/** Documents: the project's docs folder as a tree on the left, the open document on the right. */
export function Screen() {
    const store = useDocsStore();

    useEffect(() => store.activate(), [store]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') {
                event.preventDefault();
                void store.save();
            }
        };

        window.addEventListener('keydown', onKeyDown);

        return () => window.removeEventListener('keydown', onKeyDown);
    }, [store]);

    return (
        <div className={ styles.screen }>
            <DocsSidebar store={ store } />
            <DocsMain store={ store } />
        </div>
    );
}
