import { Box } from '@clowdy/components/Box';
import { Card } from '@clowdy/components/Card';
import { Text } from '@clowdy/components/Text';
import { cn } from '@clowdy/lib';
import { useState } from 'react';

import { getTheme, setTheme } from '../../theme';
import styles from './AppearancePage.module.css';
import { PanelOrderSettings } from './PanelOrderSettings';
import { ThemePreview } from './ThemePreview';
import { SettingsCard } from './ui/SettingsCard';
import { SettingsPage } from './ui/SettingsPage';
import { SettingsRow } from './ui/SettingsRow';
import { SettingsSection } from './ui/SettingsSection';

import type { Theme } from '@clowdy/constants';

const THEME_CARDS: ReadonlyArray<{ id: Theme; label: string }> = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'system', label: 'System' },
];

/** Changes the theme under a cross-fade when the browser can, and at once when it cannot or the person prefers less motion. */
function applyTheme(theme: Theme): void {
    const change = () => setTheme(theme);

    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('startViewTransition' in document)) {
        change();

        return;
    }

    try {
        document.startViewTransition(change);
    } catch {
        change();
    }
}

/** Settings > Appearance: the color theme, each choice with a picture of the app in it. */
export function AppearancePage() {
    const [theme, setThemeState] = useState(getTheme);

    return (
        <SettingsPage description="How Clowdy looks on this computer">
            <SettingsSection title="Theme">
                <SettingsCard>
                    <SettingsRow title="Color theme" description="Choose your preferred color theme">
                        <Box direction="row" gap="lg" role="group" aria-label="Theme">
                            {THEME_CARDS.map(({ id, label }) => (
                                <ThemeCard
                                    key={id}
                                    theme={id}
                                    label={label}
                                    isActive={theme === id}
                                    onSelect={() => {
                                        setThemeState(id);
                                        applyTheme(id);
                                    }}
                                />
                            ))}
                        </Box>
                    </SettingsRow>
                </SettingsCard>
            </SettingsSection>
            <PanelOrderSettings />
        </SettingsPage>
    );
}

function ThemeCard({
    theme,
    label,
    isActive,
    onSelect,
}: {
    theme: Theme;
    label: string;
    isActive: boolean;
    onSelect: () => void;
}) {
    return (
        <Box gap="md" align="start">
            <Card
                variant="bordered"
                size="sm"
                isActive={isActive}
                hoverable
                className={styles.themeCard}
                data-active={isActive || undefined}
                role="button"
                tabIndex={0}
                aria-pressed={isActive}
                aria-label={label}
                onClick={onSelect}
                onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelect();
                    }
                }}
            >
                <div className={cn(styles.preview, theme === 'system' && styles.system)}>
                    {theme === 'system' ? (
                        <>
                            <div className={styles.systemLight}>
                                <ThemePreview theme="light" />
                            </div>
                            <div className={styles.systemDark}>
                                <ThemePreview theme="dark" />
                            </div>
                        </>
                    ) : (
                        <ThemePreview theme={theme} />
                    )}
                </div>
            </Card>
            <Text variant="sm">{label}</Text>
        </Box>
    );
}
