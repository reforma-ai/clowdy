import { Text } from '@clowdy/components/Text';

import { useRootStore } from '../../stores';

const ENGINE_NAMES = { claude: 'Claude', codex: 'Codex', fake: 'the built-in test engine' } as const;

/** Settings > Engine: which engine runs the agents. Engines and accounts are the daemon's configuration, so this only reports. */
export function EnginePage() {
    const engine = useRootStore().selectedProject?.project.settings.engine;

    return (
        <Text color="secondary">
            { engine ? `This project runs agents on ${ ENGINE_NAMES[engine] }. ` : 'Agents run on the engine the daemon is set up with. ' }
            Engines and accounts are part of the daemon&apos;s configuration, so there is nothing to connect here yet.
        </Text>
    );
}
