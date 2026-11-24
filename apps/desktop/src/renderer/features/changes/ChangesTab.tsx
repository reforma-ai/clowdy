import { useProjectState, useProjectUi } from '../../stores';
import { currentPlace, isPlaceReady } from '../sidePanel/currentPlace';
import { PlaceWaiting } from '../sidePanel/PlaceWaiting';
import { ChangesView } from './ChangesView';

/**
 * The side panel's Changes tab: what changed in the place the window is working in (the same place Info, Files and the terminal name: the folder, or the worktree of the open
 * chat), as a card for each changed file with its diff, a scope menu, a filter and, at the right, a sidebar with the branch, its pull request and the commit form.
 * It reads the place's git facts, which the Info tab reads too, and is read again when they are. The open chat's last run is one of its scopes. A chat whose worktree is not made yet gets a
 * note in place of the view.
 */
export default function ChangesTab() {
    const project = useProjectState();
    const ui = useProjectUi();
    const place = currentPlace(project, ui);
    // The chat whose last run the tab offers: the open one, and none while the new-chat page is shown (its place is the page's, not the chat's).
    const chat = ui.draft || !ui.chatId ? undefined : project.chats.get(ui.chatId);

    // Each place has its own view, so one place's cards are never drawn for another.
    return isPlaceReady(place) ? (
        <ChangesView
            key={`${project.id}/${place.workspace?.id ?? place.folder.id}`}
            projectId={project.id}
            place={place}
            chat={chat}
        />
    ) : (
        <PlaceWaiting />
    );
}
