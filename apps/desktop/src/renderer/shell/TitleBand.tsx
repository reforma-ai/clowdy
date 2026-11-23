import { Button } from '@clowdy/components/Button';
import { ChevronLeft, ChevronRight } from '@clowdy/icons/16';

import { commandTooltip } from '../hotkeys';
import { useRootStore } from '../stores';
import styles from './TitleBand.module.css';
import { UsageStatus } from './UsageStatus';

/**
 * The 44px band over the top edge of the window, as wide as the window is up to the side panel's rail, which is as tall as the window and has the panel's button at its top.
 * On macOS the traffic lights sit at the left, then come back and forward; on Windows the caption buttons sit at the right, over the rail and a part of the band, and the
 * band leaves room for that part. The page draws neither. The right edge holds the usage status (a badge for each provider that can be used).
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
                    <div className={ styles.end }>
                        <UsageStatus />
                    </div>
                </>
            ) }
        </header>
    );
}
