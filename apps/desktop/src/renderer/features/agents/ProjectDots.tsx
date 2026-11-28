import { Tooltip } from '@clowdy/components/Tooltip';

import { ProjectIcon } from '../../shared/ProjectIcon';
import { useRootStore } from '../../stores';
import styles from './ProjectDots.module.css';

/** A dot per space under the chat list, in menu order. It stays put while the lists slide past above it. */
export function ProjectDots() {
    const root = useRootStore();

    return (
        <nav className={styles.dots} aria-label="Switch space">
            {[
                ...root.projects.filter(candidate => candidate.personal),
                ...root.projects.filter(candidate => !candidate.personal),
            ].map(candidate => (
                <Tooltip
                    key={candidate.id}
                    placement="top"
                    warmUp
                    content={
                        <span className={styles.tooltip}>
                            <ProjectIcon project={candidate} />
                            {candidate.name}
                        </span>
                    }
                >
                    <button
                        type="button"
                        className={styles.dot}
                        aria-label={candidate.name}
                        aria-current={candidate.id === root.selectedProjectId ? 'true' : undefined}
                        onClick={() => root.selectProject(candidate.id)}
                    >
                        <span />
                    </button>
                </Tooltip>
            ))}
        </nav>
    );
}
