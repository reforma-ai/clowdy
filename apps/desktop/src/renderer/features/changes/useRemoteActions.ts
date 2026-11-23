import { useRootStore } from '../../stores';
import { gitFactsOf, type PlaceFacts } from './gitFacts';
import { remoteActionsOf, type RemoteActions } from './RemoteActions';

/** The moves of a place's branch to and from `origin`, which the sidebar's menu, its Create PR and the strip's share. A run ends with a new round of the place's git facts. */
export function useRemoteActions(facts: PlaceFacts): RemoteActions {
    const { transport } = useRootStore();

    return remoteActionsOf(facts, transport, () => gitFactsOf(transport).refresh(facts.key));
}
