import { Button } from '@clowdy/components/Button';
import { ChevronLeft, ChevronRight, Keyboard } from '@clowdy/icons/16';
import { cn } from '@clowdy/lib';

import { SidePanelToggle, useSidePanel } from '../features/sidePanel';
import { commandTooltip } from '../hotkeys';
import { openHelp } from '../hotkeys/openHelp';
import { useRootStore } from '../stores';
import { ProjectSelect } from './ProjectSelect';
import styles from './TitleBand.module.css';
import { UsageStatus } from './UsageStatus';

/**
 * The 48px band over the window's top edge. On macOS the traffic lights sit at the left, then come back and forward and the project select;
 * on Windows the caption buttons sit at the right, and the band leaves room for them. The page draws neither.
 * The right edge holds the usage status (a badge for each provider that can be used) and, last, the shortcuts button, which opens the same overlay as `?`.
 */
export function TitleBand() {
    const root = useRootStore();
    const { history } = root;
    const panel = useSidePanel();

    return (
        <header className={ cn(styles.band, panel.open && styles.beside) }>
            { root.phase === 'ready' && (
                <>
                    <div className={ styles.history }>
                        <Button
                            variant="filling"
                            size="sm"
                            iconOnly
                            aria-label="Back"
                            tooltip={ commandTooltip('Back', 'nav.back') ?? 'Back' }
                            tooltipPlacement="bottom"
                            isDisabled={ !history.canGoBack }
                            onPress={ () => history.back() }
                        >
                            <ChevronLeft />
                        </Button>
                        <Button
                            variant="filling"
                            size="sm"
                            iconOnly
                            aria-label="Forward"
                            tooltip={ commandTooltip('Forward', 'nav.forward') ?? 'Forward' }
                            tooltipPlacement="bottom"
                            isDisabled={ !history.canGoForward }
                            onPress={ () => history.forward() }
                        >
                            <ChevronRight />
                        </Button>
                    </div>
                    <ProjectSelect />
                    <div className={ styles.end }>
                        <UsageStatus />
                        <Button
                            variant="filling"
                            size="sm"
                            iconOnly
                            aria-label="Keyboard shortcuts"
                            tooltip={ commandTooltip('Keyboard shortcuts', 'help.open') ?? 'Keyboard shortcuts' }
                            tooltipPlacement="bottom"
                            onPress={ () => openHelp() }
                        >
                            <Keyboard />
                        </Button>
                        { !panel.open && <SidePanelToggle /> }
                    </div>
                </>
            ) }
        </header>
    );
}
