import { Switch } from '@clowdy/components/Switch';
import { Text } from '@clowdy/components/Text';

import { AccountRow } from './AccountRow';
import styles from './ProviderCard.module.css';
import { ProviderIcon } from './ProviderIcon';
import { ProviderSettings } from './ProviderSettings';
import { UsageBlock } from './UsageBlock';
import { useAgentCommands } from './useAgentCommands';

import type { AgentInfo } from '@clowdy/protocol';

/**
 * One provider: its mark, name and switch; who is signed in with the button to sign in; what is left of its plan; and its
 * settings. A provider that is off or not installed shows less, because there is nothing to sign in to or to read.
 */
export function ProviderCard({ agent }: { agent: AgentInfo }) {
    const commands = useAgentCommands(agent.id);
    const installed = agent.status !== 'missing' && agent.status !== 'needs-runtime';
    const isOn = agent.enabled && installed;
    const usage = isOn ? agent.usage : undefined;

    return (
        <section className={ styles.card } aria-label={ agent.name }>
            <header className={ styles.header }>
                <span className={ styles.icon }><ProviderIcon agentId={ agent.id } size={ 22 } /></span>
                <div className={ styles.title }>
                    <Text bold>{ agent.name }</Text>
                    { agent.version && <Text variant="xs" color="secondary" className={ styles.version }>{ `v${ agent.version }` }</Text> }
                </div>
                <Switch
                    size="sm"
                    isSelected={ isOn }
                    isDisabled={ !installed }
                    isPending={ commands.pending.has('enabled') }
                    aria-label={ `Use ${ agent.name } in Clowdy` }
                    onChange={ enabled => void commands.setEnabled(enabled) }
                />
            </header>

            <div className={ styles.section }>
                <AccountRow agent={ agent } commands={ commands } />
            </div>

            { usage && (
                <div className={ styles.section }>
                    <UsageBlock usage={ usage } isRefreshing={ commands.pending.has('refresh') } onRefresh={ () => void commands.refresh() } />
                </div>
            ) }

            <div className={ styles.section } data-dim={ !isOn || undefined }>
                <ProviderSettings agent={ agent } commands={ commands } />
            </div>
        </section>
    );
}
