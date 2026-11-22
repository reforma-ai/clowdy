import { Button } from '@clowdy/components/Button';
import { ChevronLeft, ChevronRight } from '@clowdy/icons/16';

import { SidePanelCorner } from '../features/sidePanel';
import { commandTooltip } from '../hotkeys';
import { useRootStore } from '../stores';
import { ProjectSelect } from './ProjectSelect';
import styles from './TitleBand.module.css';
import { UsageStatus } from './UsageStatus';

/**
 * The 48px band over the window's top edge, one band across the whole window whether the side panel is open or not. On macOS the traffic lights sit at the left,
 * then come back and forward and the project select; on Windows the caption buttons sit at the right, and the band leaves room for them. The page draws neither.
 * The right edge holds the usage status (a badge for each provider that can be used), and after it the corner over the side panel's rail, which is free of the badges
 * and has the button that expands the panel.
 */
export function TitleBand() {
    const root = useRootStore();
    const { history } = root;

    return (
        <header className={ styles.band }>
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
                        <SidePanelCorner />
                    </div>
                </>
            ) }
        </header>
    );
}
