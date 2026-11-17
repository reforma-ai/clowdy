import { useRootStore } from '../stores';
import { ProjectSelect } from './ProjectSelect';
import styles from './TitleBand.module.css';

/**
 * The 48px band over the window's top edge. On macOS the traffic lights sit at the left and the project select
 * follows them; on Windows the caption buttons sit at the right. The page draws neither.
 */
export function TitleBand() {
    const root = useRootStore();

    return (
        <header className={ styles.band }>
            { root.phase === 'ready' && <ProjectSelect /> }
        </header>
    );
}
