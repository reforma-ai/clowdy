import { ChevronRight } from '@clowdy/icons/8';
import { Devices, Moon, Sun } from '@clowdy/icons/14';
import { NightMode } from '@clowdy/icons/16';

import { For } from '../For';
import { Popover } from '../Popover';
import { Menu, MenuItem, SubmenuTrigger } from './Menu';

import type { Theme } from '@clowdy/constants';
import type { ReactNode } from 'react';

const THEME_OPTIONS: ReadonlyArray<{ value: Theme; icon: ReactNode; label: string }> = [
    { value: 'light', icon: <Sun />, label: 'Light' },
    { value: 'dark', icon: <Moon />, label: 'Dark' },
    { value: 'system', icon: <Devices />, label: 'System' },
];

export interface AppearanceSubmenuProps {
    value?: string;
    onChange: (theme: Theme) => void;
}

/** Fly-out theme picker for use inside a parent `Menu`. */
export function AppearanceSubmenu({ value, onChange }: AppearanceSubmenuProps) {
    const selectedTheme: Theme = value === 'dark' || value === 'system' ? value : 'light';

    return (
        <SubmenuTrigger>
            <MenuItem id="appearance" text="Appearance" icon={<NightMode />} endAffix={<ChevronRight />} />

            <Popover spacing="xs" width={180}>
                <Menu
                    aria-label="Appearance"
                    size="md"
                    selectionMode="single"
                    selectedKeys={[selectedTheme]}
                    disallowEmptySelection
                    onSelectionChange={keys => {
                        const next = keys === 'all' ? undefined : [...keys][0];

                        if (next === 'light' || next === 'dark' || next === 'system') {
                            onChange(next);
                        }
                    }}
                >
                    <For each={THEME_OPTIONS}>
                        {option => (
                            <MenuItem key={option.value} id={option.value} text={option.label} icon={option.icon} />
                        )}
                    </For>
                </Menu>
            </Popover>
        </SubmenuTrigger>
    );
}
