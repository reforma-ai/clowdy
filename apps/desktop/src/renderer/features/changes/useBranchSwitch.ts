import { useRootStore } from '../../stores';
import { refreshFolderGit } from '../openWith';
import { type BranchSwitch, branchSwitchOf } from './BranchSwitch';
import { gitFactsOf, type PlaceFacts } from './gitFacts';

/** The branch switch of a place of the Changes sidebar. When a switch ends the place's facts are read again (the status, the changes and the Info rows) and so is the folder's branch (the chats' folder chips). */
export function useBranchSwitch(facts: PlaceFacts): BranchSwitch {
    const { transport } = useRootStore();

    return branchSwitchOf(facts, transport, () => {
        gitFactsOf(transport).refresh(facts.key);
        refreshFolderGit(facts.key.projectId, facts.key.folderId);
    });
}
