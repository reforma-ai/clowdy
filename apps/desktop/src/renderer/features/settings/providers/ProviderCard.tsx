import { Switch } from '@clowdy/components/Switch';
import { Text } from '@clowdy/components/Text';

import { SettingsBlock } from '../ui/SettingsBlock';
import { SettingsCard } from '../ui/SettingsCard';
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
        <SettingsCard as="section" divided aria-label={ agent.name }>
            <SettingsBlock className={ styles.identity }>
                <header className={ styles.header }>
                    <span className={ styles.icon }><ProviderIcon agentId={ agent.id } size={ 22 } /></span>
                    <div className={ styles.title }>
                        <Text weight="medium">{ agent.name }</Text>
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

                <AccountRow agent={ agent } commands={ commands } />
            </SettingsBlock>

            { usage && (
                <SettingsBlock>
                    <UsageBlock usage={ usage } isRefreshing={ commands.pending.has('refresh') } onRefresh={ () => void commands.refresh() } />
                </SettingsBlock>
            ) }

            <SettingsBlock data-dim={ !isOn || undefined } className={ styles.settings }>
                <ProviderSettings agent={ agent } commands={ commands } />
            </SettingsBlock>
        </SettingsCard>
    );
}
