import { PanelEmptyState, PanelLoadingState } from '@clowdy/components/Panel';
import { SettingsLayout } from '@clowdy/components/SettingsLayout';
import { useEffect } from 'react';

import { useAgents, useRootStore } from '../../../stores';
import { ReadFailed } from '../ReadFailed';
import { ProviderCard } from './ProviderCard';
import styles from './ProvidersPage.module.css';
import { providerAgents } from './providerView';

/** How often the page asks for the agents while it is open; the daemon reads again only what is older than its own freshness. */
const POLL_MS = 60_000;

const INTRO = "The agents Clowdy can run. Each one uses the account you're already signed in with on this computer.";

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
            <SettingsLayout.Page description={INTRO}>
                <PanelLoadingState label="Looking for agents…" />
            </SettingsLayout.Page>
        );
    }

    if (status === 'failed' && agents.length === 0) {
        return (
            <SettingsLayout.Page description={INTRO}>
                <ReadFailed message={`The agents could not be loaded. ${error}`} onRetry={() => void refresh()} />
            </SettingsLayout.Page>
        );
    }

    return (
        <SettingsLayout.Page description={INTRO}>
            {status === 'failed' && (
                <ReadFailed
                    message={`The agents could not be read again, so what is shown may be out of date. ${error}`}
                    onRetry={() => void refresh()}
                />
            )}
            {providers.length === 0 ? (
                <PanelEmptyState fill={false} label="The daemon lists none of Claude Code, Codex or Cursor" />
            ) : (
                <div className={styles.cards}>
                    {providers.map(agent => (
                        <ProviderCard key={agent.id} agent={agent} />
                    ))}
                </div>
            )}
        </SettingsLayout.Page>
    );
}
