import { Button } from '@clowdy/components/Button';
import { Info } from '@clowdy/icons/16';

import { InfoTab } from './InfoTab';
import styles from './SidePanel.module.css';
import { SidePanelToggle } from './SidePanelToggle';

/**
 * The column at the right of the window, with the window's chrome behind its header and a paper plate under it, as a second sidebar. The header is
 * where the tabs are to go; for now it has the one tab there is, Info, and the button that shuts the panel at the window's right edge. Everything
 * the panel is to show later (files, changes, a terminal) becomes a tab of its own beside this one.
 */
export function SidePanel() {
    return (
        <aside className={ styles.panel } aria-label="Panel">
            <header className={ styles.header }>
                <div className={ styles.tabs }>
                    {/* The only tab, and always the chosen one: a toggle with nothing to switch to until there is a second tab. */}
                    <Button variant="filling" size="sm" iconOnly aria-label="Info" tooltip="Info" tooltipPlacement="bottom" isPressed>
                        <Info />
                    </Button>
                </div>
                <div className={ styles.end }>
                    <SidePanelToggle />
                </div>
            </header>
            <section className={ styles.plate } aria-label="Info">
                <InfoTab />
            </section>
        </aside>
    );
}
