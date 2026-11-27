import { tildePath } from '../../shared/displayPath';
import { homeFolder } from '../../shared/homeFolder';
import styles from './ChatFolder.module.css';

export function PlaceTooltip({
    path,
    worktree,
    note,
    detached,
}: {
    path: string;
    worktree: boolean;
    note?: string;
    detached?: boolean;
}) {
    return (
        <div className={styles.tooltip}>
            <span>{worktree ? 'Working in worktree' : 'Working in project folder'}</span>
            <span className={styles.tooltipPath}>{tildePath(path, homeFolder.path)}</span>
            {note && <span>{note}</span>}
            {detached && <span>Detached HEAD</span>}
        </div>
    );
}
