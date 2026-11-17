import { Box } from '@clowdy/components/Box';
import { SettingsField } from '@clowdy/components/SettingsField';
import { Text } from '@clowdy/components/Text';
import { ToggleButtonGroup, ToggleButtonGroupItem } from '@clowdy/components/ToggleButtonGroup';
import { THEMES, type Theme } from '@clowdy/constants';
import { Devices, Moon, Sun } from '@clowdy/icons/14';
import { useState } from 'react';

import { useRootStore } from '../../stores';
import { getTheme, setTheme } from '../../theme';
import styles from './Screen.module.css';
import { SkillsSection } from './skills';

const ENGINE_NAMES = { claude: 'Claude', codex: 'Codex', fake: 'the built-in test engine' } as const;

const APPEARANCES: ReadonlyArray<{ value: Theme; label: string; icon: React.ReactNode }> = [
    { value: 'system', label: 'System', icon: <Devices /> },
    { value: 'light', label: 'Light', icon: <Sun /> },
    { value: 'dark', label: 'Dark', icon: <Moon /> },
];

/** Global settings: nothing here belongs to a project. */
export function Screen() {
    const root = useRootStore();
    const [theme, setThemeState] = useState(getTheme);
    const engine = root.selectedProject?.project.settings.engine;

    return (
        <div className={ styles.page }>
            <Text variant="heading-2">Settings</Text>

            <Box gap="md" className={ styles.section }>
                <Text variant="heading-4">Appearance</Text>
                <SettingsField layout="horizontal">
                    <SettingsField.Label>Theme</SettingsField.Label>
                    <ToggleButtonGroup
                        aria-label="Theme"
                        size="sm"
                        selectedKeys={ [theme] }
                        onSelectionChange={ (keys) => {
                            const next = THEMES.find(candidate => keys.has(candidate));

                            if (next) {
                                setTheme(next);
                                setThemeState(next);
                            }
                        } }
                    >
                        { APPEARANCES.map(({ value, label, icon }) => (
                            <ToggleButtonGroupItem key={ value } value={ value }>
                                { icon }
                                { label }
                            </ToggleButtonGroupItem>
                        )) }
                    </ToggleButtonGroup>
                </SettingsField>
            </Box>

            <Box gap="md" className={ styles.section }>
                <Text variant="heading-4">Engine</Text>
                <Text color="secondary">
                    { engine ? `This project runs agents on ${ ENGINE_NAMES[engine] }. ` : 'Agents run on the engine the daemon is set up with. ' }
                    Engines and accounts are part of the daemon&apos;s configuration, so there is nothing to connect here yet.
                </Text>
            </Box>

            <Box gap="md" className={ styles.section }>
                <SkillsSection />
            </Box>
        </div>
    );
}
