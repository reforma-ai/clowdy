import { Spinner } from '@clowdy/components/Spinner';

import { useRootStore } from '../stores';
import styles from './SyncBanner.module.css';

/** The one sign that the daemon is out of reach. It appears after a few seconds of failure and is absent otherwise. */
export function SyncBanner() {
    const root = useRootStore();

    if (!root.bannerVisible) return null;

    return (
        <div className={ styles.banner } role="status">
            <Spinner size="xs" />
            Can&apos;t reach the daemon. Retrying…
        </div>
    );
}
