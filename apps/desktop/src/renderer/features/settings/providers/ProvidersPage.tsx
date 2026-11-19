import { Alert, AlertAction, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { Loader } from '@clowdy/components/Loader';
import { Text } from '@clowdy/components/Text';
import { AttentionCircle } from '@clowdy/icons/14';
import { useEffect } from 'react';

import { useAgents, useRootStore } from '../../../stores';
import { SettingsEmpty } from '../ui/SettingsEmpty';
import { SettingsPage } from '../ui/SettingsPage';
import { ProviderCard } from './ProviderCard';
import styles from './ProvidersPage.module.css';
import { providerAgents } from './providerView';

/** How often the page asks for the agents while it is open; the daemon reads again only what is older than its own freshness. */
const POLL_MS = 60_000;

const INTRO = 'The agents Clowdy can run. Each one uses the account you\'re already signed in with on this computer.';

/** Settings > Providers: one card per provider, with its account, its usage and its settings. */
export function ProvidersPage() {
    const { agents, status, error, refresh } = useAgents();
    const root = useRootStore();
    const providers = providerAgents(agents);

    // The daemon reads accounts and usage again when somebody asks for the agents and its last read is old, and it lets a
    // finished sign-in lapse the same way: what the app fetched an hour ago is not what the page should show.
    useEffect(() => {
        void root.refreshAgents();

        // Usage moves while the page is open; a hidden window does not need it.
        const timer = setInterval(() => {
            if (!document.hidden) void root.refreshAgents();
        }, POLL_MS);

        return () => clearInterval(timer);
    }, [root]);

    if (status === 'loading' && agents.length === 0) {
        return (
            <SettingsPage title="Providers" description={ INTRO }>
                <Box direction="row" gap="md" align="center">
                    <Loader size="md" />
                    <Text color="secondary">Looking for agents…</Text>
                </Box>
            </SettingsPage>
        );
    }

    if (status === 'failed' && agents.length === 0) {
        return (
            <SettingsPage title="Providers" description={ INTRO }>
                <Box gap="md" align="start">
                    <Text color="danger">The agents could not be loaded. { error }</Text>
                    <Button variant="bordered" size="sm" onPress={ () => void refresh() }>Try again</Button>
                </Box>
            </SettingsPage>
        );
    }

    return (
        <SettingsPage title="Providers" description={ INTRO }>
            { status === 'failed' && (
                <Alert color="danger">
                    <AlertIcon><AttentionCircle /></AlertIcon>
                    <AlertDescription>{ `The agents could not be read again, so what is shown may be out of date. ${ error }` }</AlertDescription>
                    <AlertAction><Button size="sm" variant="bordered" onPress={ () => void refresh() }>Try again</Button></AlertAction>
                </Alert>
            ) }
            { providers.length === 0
                ? <SettingsEmpty>The daemon lists none of Claude Code, Codex or Cursor.</SettingsEmpty>
                : <div className={ styles.cards }>{ providers.map(agent => <ProviderCard key={ agent.id } agent={ agent } />) }</div> }
        </SettingsPage>
    );
}
