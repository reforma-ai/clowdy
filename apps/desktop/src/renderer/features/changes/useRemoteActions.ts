import { useRootStore } from '../../stores';
import { gitFactsOf, type PlaceFacts } from './gitFacts';
import { type RemoteActions, remoteActionsOf } from './RemoteActions';

/** The sidebar and Commit & Sync share the remote actions for a place. Each completion refreshes its Git facts. */
export function useRemoteActions(facts: PlaceFacts): RemoteActions {
    const { transport } = useRootStore();

    return remoteActionsOf(facts, transport, () => gitFactsOf(transport).refresh(facts.key));
}
