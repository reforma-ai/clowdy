import { useRootStore } from '../../stores';
import { type ChangesSummary, changesSummary } from '../changes/changesStage';
import { useGitFacts } from '../changes/useGitFacts';
import { currentPlace } from './currentPlace';

/**
 * What the rail says of the changes of the place the window works in (the one the Changes tab shows), whether that tab is on show or not. It reads the place's git facts, as the
 * tab does (the store counts the readers, so they are one). Nothing while no project's screen is on show, the place is a worktree not made yet, or it is no repository.
 */
export function useChangesSummary(): ChangesSummary | undefined {
    const root = useRootStore();
    const project = root.projectScreenReady ? root.selectedProject : undefined;
    const ui = project ? root.ui.forProject(project.id) : undefined;
    const place = project && ui ? currentPlace(project, ui) : undefined;
    const facts = useGitFacts(project?.id, place);

    return facts && changesSummary(facts.status.value, facts.pr);
}
