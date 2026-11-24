import { isPlaceReady, type Place } from '../sidePanel/currentPlace';
import { gitFactsOf } from './gitFacts';
import { placeChangesOf } from './PlaceChanges';

import type { ChatId, GitScope, ProjectId } from '@clowdy/protocol';
import type { RootStore } from '../../stores';

/**
 * Shows the Changes tab on what a chat's latest run changed (`scope`, the run's two trees) and brings the card of `path` up once the list of the run is read, opening the side panel
 * when it is shut. The tab shows the place the window works in, so a caller offers this for the open chat's own place. A worktree that is not made yet has no changes to show:
 * nothing is done and `false` says so.
 */
export function openRunInChanges(
    root: RootStore,
    projectId: ProjectId,
    place: Place,
    chatId: ChatId,
    scope: GitScope,
    path?: string
): boolean {
    if (!isPlaceReady(place)) return false;

    const key = { projectId, folderId: place.folder.id, ...(place.workspace && { workspaceId: place.workspace.id }) };
    const model = placeChangesOf(root.transport, gitFactsOf(root.transport).of(key));

    model.showRun(chatId, scope, path);
    root.ui.forProject(projectId).openSidePanelTab('changes');

    return true;
}
