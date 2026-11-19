import { Switch } from '@clowdy/components/Switch';
import { Text } from '@clowdy/components/Text';

import { SettingsBlock } from '../ui/SettingsBlock';
import { SettingsCard } from '../ui/SettingsCard';
import { AccountLine, SignInAction, SignInStatus } from './Account';
import styles from './ProviderCard.module.css';
import { ProviderIcon } from './ProviderIcon';
import { ProviderAdvanced, ProviderSettings } from './ProviderSettings';
import { UsageBlock } from './UsageBlock';
import { RefreshUsageButton } from './UsageRows';
import { useAgentCommands } from './useAgentCommands';

import type { AgentInfo } from '@clowdy/protocol';

/**
 * One provider. Its first block is one row: the mark; the name over who is signed in; and at the end the button that reads the usage
 * again, the sign-in button and the switch. A running sign-in, or how it ended, goes under the name. Then what is left of its plan, its
 * settings, and Advanced, each in a block of its own. A provider that is off or not installed shows less, because there is nothing to
 * sign in to or to read.
 */
export function ProviderCard({ agent }: { agent: AgentInfo }) {
    const commands = useAgentCommands(agent.id);
    const installed = agent.status !== 'missing' && agent.status !== 'needs-runtime';
    const isOn = agent.enabled && installed;
    const usage = isOn ? agent.usage : undefined;

    return (
        <SettingsCard as="section" divided aria-label={ agent.name }>
            <SettingsBlock className={ styles.identity }>
                <span className={ styles.icon }><ProviderIcon agentId={ agent.id } size={ 24 } /></span>

                <div className={ styles.who }>
                    <header className={ styles.title }>
                        <Text weight="medium" truncate title={ agent.name }>{ agent.name }</Text>
                        { agent.version && <Text variant="xs" color="secondary" className={ styles.version }>{ `v${ agent.version }` }</Text> }
                    </header>
                    <AccountLine agent={ agent } />
                </div>

                <div className={ styles.actions }>
                    { usage && <RefreshUsageButton size="sm" isRefreshing={ commands.pending.has('refresh') } onRefresh={ () => void commands.refresh() } /> }
                    <SignInAction agent={ agent } commands={ commands } />
                    <Switch
                        size="sm"
                        className={ styles.switch }
                        isSelected={ isOn }
                        isDisabled={ !installed }
                        isPending={ commands.pending.has('enabled') }
                        aria-label={ `Use ${ agent.name } in Clowdy` }
                        onChange={ enabled => void commands.setEnabled(enabled) }
                    />
                </div>

                <SignInStatus agent={ agent } commands={ commands } className={ styles.status } />
            </SettingsBlock>

            { usage && (
                <SettingsBlock>
                    <UsageBlock usage={ usage } />
                </SettingsBlock>
            ) }

            { (agent.settings ?? []).length > 0 && (
                <SettingsBlock data-dim={ !isOn || undefined } className={ styles.settings }>
                    <ProviderSettings agent={ agent } commands={ commands } />
                </SettingsBlock>
            ) }

            <SettingsBlock data-dim={ !isOn || undefined } className={ styles.settings }>
                <ProviderAdvanced agent={ agent } commands={ commands } />
            </SettingsBlock>
        </SettingsCard>
    );
}
