import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';

import { useAgents } from '../../../stores';
import { ProviderCard } from './ProviderCard';
import styles from './ProvidersPage.module.css';
import { providerAgents } from './providerView';

const INTRO = (
    <Text color="secondary">
        The agents Clowdy runs: who is signed in to each, what is left of its plan, and how it starts. Clowdy uses the login the program already has on this computer.
    </Text>
);

/** Settings > Providers (the window's own title is the page's): one card per provider, with its account, its usage and its settings. */
export function ProvidersPage() {
    const { agents, status, error, refresh } = useAgents();
    const providers = providerAgents(agents);

    if (status === 'loading' && agents.length === 0) {
        return (
            <>
                { INTRO }
                <Box direction="row" gap="md" align="center">
                    <Spinner size="sm" />
                    <Text color="secondary">Looking for agents…</Text>
                </Box>
            </>
        );
    }

    if (status === 'failed' && agents.length === 0) {
        return (
            <>
                { INTRO }
                <Box gap="md" align="start">
                    <Text color="danger">The agents could not be loaded. { error }</Text>
                    <Button variant="bordered" size="sm" onPress={ () => void refresh() }>Try again</Button>
                </Box>
            </>
        );
    }

    return (
        <>
            { INTRO }
            { providers.length === 0
                ? <Text color="secondary" className={ styles.empty }>The daemon lists none of Claude Code, Codex or Cursor.</Text>
                : <div className={ styles.cards }>{ providers.map(agent => <ProviderCard key={ agent.id } agent={ agent } />) }</div> }
        </>
    );
}
