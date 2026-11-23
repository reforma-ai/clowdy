import { PanelEmptyState } from '@clowdy/components/Panel';

/**
 * What a tab of the side panel says while the open chat's worktree is not made: the chat's first turn makes it, and until then there is nothing of it to show, nor is the
 * folder's own checkout what the chat works in.
 */
export function PlaceWaiting() {
    return <PanelEmptyState title="The worktree is not made yet" description="Its files and terminals show here once the chat's first message has made it" />;
}
