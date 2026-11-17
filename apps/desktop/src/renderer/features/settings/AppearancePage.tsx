import { SettingsField } from '@clowdy/components/SettingsField';
import { ToggleButtonGroup, ToggleButtonGroupItem } from '@clowdy/components/ToggleButtonGroup';
import { THEMES, type Theme } from '@clowdy/constants';
import { Devices, Moon, Sun } from '@clowdy/icons/14';
import { useState } from 'react';

import { getTheme, setTheme } from '../../theme';

const APPEARANCES: ReadonlyArray<{ value: Theme; label: string; icon: React.ReactNode }> = [
    { value: 'system', label: 'System', icon: <Devices /> },
    { value: 'light', label: 'Light', icon: <Sun /> },
    { value: 'dark', label: 'Dark', icon: <Moon /> },
];

/** Settings > Appearance: the colour theme. */
export function AppearancePage() {
    const [theme, setThemeState] = useState(getTheme);

    return (
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
    );
}
