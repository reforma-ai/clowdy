import { Button } from '@clowdy/components/Button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger, useCollapsible } from '@clowdy/components/Collapsible';
import { Input } from '@clowdy/components/Input';
import { Show } from '@clowdy/components/Show';
import { Switch } from '@clowdy/components/Switch';
import { Text } from '@clowdy/components/Text';
import { Textarea } from '@clowdy/components/Textarea';
import { ChevronDown } from '@clowdy/icons/8';
import { cn } from '@clowdy/lib';
import { useState } from 'react';

import styles from './ProviderSettings.module.css';
import { parseEnv } from './providerView';

import type { AgentInfo, AgentSetting } from '@clowdy/protocol';
import type { useAgentCommands } from './useAgentCommands';

interface SettingsProps {
    agent: AgentInfo;
    commands: ReturnType<typeof useAgentCommands>;
}

function SettingRow({ setting, isPending, onChange }: { setting: AgentSetting; isPending: boolean; onChange: (value: boolean) => void }) {
    return (
        <li className={ styles.setting }>
            <div className={ styles.text }>
                <Text variant="sm" bold>{ setting.label }</Text>
                { setting.description && <Text variant="sm" color="secondary">{ setting.description }</Text> }
            </div>
            <Switch size="sm" isSelected={ setting.value } isPending={ isPending } aria-label={ setting.label } onChange={ onChange } />
        </li>
    );
}

function AdvancedTrigger() {
    const { state } = useCollapsible();

    return (
        <CollapsibleTrigger asChild>
            <Button type="button" variant="inline" color="secondary" size="sm" className={ styles.trigger }>
                Advanced
                <ChevronDown className={ cn('chevron', 'next') } aria-expanded={ state.isExpanded } aria-hidden />
            </Button>
        </CollapsibleTrigger>
    );
}

function AdvancedPanel({ children }: { children: React.ReactNode }) {
    const { state } = useCollapsible();

    return (
        <Show when={ state.isExpanded }>
            <CollapsibleContent className={ styles.advanced }>{ children }</CollapsibleContent>
        </Show>
    );
}

/** Where the program is, and the environment it starts with. Both are what the daemon keeps for the agent. */
function Advanced({ agent, commands }: SettingsProps) {
    const [path, setPath] = useState('');
    const [env, setEnv] = useState('');
    const parsed = parseEnv(env);
    const envError = env.trim() && !parsed.ok ? parsed.message : undefined;

    return (
        <Collapsible>
            <AdvancedTrigger />
            <AdvancedPanel>
                <div className={ styles.field }>
                    <Text variant="sm" bold>Program</Text>
                    <Text variant="sm" color="secondary" truncate title={ agent.path }>
                        { agent.path ? `Found at ${ agent.path }` : 'Not found on this computer.' }
                    </Text>
                    <div className={ styles.inputs }>
                        <Input
                            type="text"
                            variant="bordered"
                            size="sm"
                            aria-label={ `Path to the ${ agent.name } program` }
                            placeholder="Use another program: /path/to/program"
                            value={ path }
                            onChange={ setPath }
                        />
                        <Button
                            variant="bordered"
                            size="sm"
                            isDisabled={ !path.trim() }
                            isPending={ commands.pending.has('path') }
                            onPress={ () => void commands.setPath(path.trim()).then(ok => ok && setPath('')) }
                        >
                            Use it
                        </Button>
                        <Button variant="inline" color="secondary" size="sm" isDisabled={ commands.pending.has('path') } onPress={ () => void commands.setPath(null) }>Find it again</Button>
                    </div>
                </div>

                <div className={ styles.field }>
                    <Text variant="sm" bold>Environment</Text>
                    <Text variant="sm" color="secondary">Variables the program starts with, one KEY=VALUE per line. Saving replaces the ones saved before, and an empty box clears them.</Text>
                    <Textarea
                        variant="bordered"
                        size="sm"
                        aria-label={ `Environment of ${ agent.name }` }
                        placeholder="KEY=VALUE"
                        rows={ 3 }
                        value={ env }
                        isInvalid={ Boolean(envError) }
                        onChange={ setEnv }
                    />
                    { envError && <Text variant="sm" color="danger" role="alert">{ envError }</Text> }
                    <div>
                        <Button
                            variant="bordered"
                            size="sm"
                            isDisabled={ !parsed.ok }
                            isPending={ commands.pending.has('env') }
                            onPress={ () => parsed.ok && void commands.setEnv(parsed.env) }
                        >
                            Save the environment
                        </Button>
                    </div>
                </div>
            </AdvancedPanel>
        </Collapsible>
    );
}

/** The agent's own settings as switches, and the Advanced part (program and environment). */
export function ProviderSettings({ agent, commands }: SettingsProps) {
    const settings = agent.settings ?? [];

    return (
        <section className={ styles.block } aria-label={ `${ agent.name } settings` }>
            { settings.length > 0 && (
                <ul className={ styles.list }>
                    { settings.map(setting => (
                        <SettingRow
                            key={ setting.id }
                            setting={ setting }
                            isPending={ commands.pending.has(`setting:${ setting.id }`) }
                            onChange={ value => void commands.setSetting(setting.id, value) }
                        />
                    )) }
                </ul>
            ) }
            <Advanced agent={ agent } commands={ commands } />
        </section>
    );
}
