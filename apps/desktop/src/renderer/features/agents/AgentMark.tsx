import { Message } from '@clowdy/icons/14';

import { ProviderIcon } from '../settings/providers/ProviderIcon';
import { PROVIDER_IDS } from '../settings/providers/providerView';

/** The mark of the agent a chat runs on: the provider's own, or a speech bubble while the agent is not known or has no mark of its own. */
export function AgentMark({ engine }: { engine: string | undefined }) {
    if (engine === undefined || !(PROVIDER_IDS as readonly string[]).includes(engine)) return <Message />;

    return <ProviderIcon agentId={engine} size={14} data-provider={engine} />;
}
