import { Button } from '@clowdy/components/Button';
import { Undo } from '@clowdy/icons/14';

import { useRootStore } from '../../stores';
import { openDiscardDialog } from './DiscardDialog';
import { discardChanges } from './discardChanges';
import { discardSpot, keepFocusWhenGone } from './discardFocus';

import type { GitChangedFile } from '@clowdy/protocol';
import type { PlaceChanges } from './PlaceChanges';

/** Confirm and discard a file's uncommitted changes from its diff card. */
export function DiscardButton({
    model,
    file,
    className,
}: {
    model: PlaceChanges;
    file: GitChangedFile;
    className?: string;
}) {
    const root = useRootStore();

    return (
        <Button
            variant="filling"
            color="secondary"
            size="sm"
            iconOnly
            className={className}
            aria-label={`Discard changes to ${file.path}`}
            tooltip="Discard changes…"
            tooltipPlacement="bottom"
            data-discard={file.path}
            onPress={event => {
                // Read at the press, while the card is still present.
                const spot = discardSpot(event.target);

                openDiscardDialog({
                    file,
                    discard: async () => {
                        const result = await discardChanges(model, root.transport, file.path);

                        if (spot) keepFocusWhenGone(spot);

                        return result;
                    },
                });
            }}
        >
            <Undo aria-hidden="true" />
        </Button>
    );
}
