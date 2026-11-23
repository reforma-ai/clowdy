import { Button } from '@clowdy/components/Button';
import { Undo } from '@clowdy/icons/14';

import { useProjectState, useRootStore } from '../../stores';
import { openDiscardDialog } from './DiscardDialog';
import { discardChanges } from './discardChanges';
import { discardSpot, keepFocusWhenGone } from './discardFocus';
import { agentsWorkingIn } from './discardRules';

import type { ButtonProps } from '@clowdy/components/Button';
import type { GitChangedFile } from '@clowdy/protocol';
import type { PlaceChanges } from './PlaceChanges';

/**
 * `Discard changes…` for one file of the place: an icon button of the design system, as the copy button beside it on a card and the actions of a chat's row are, that its row or card
 * header shows when the pointer is over it or the focus is in it (the row's list does that, and the card's CSS), and which opens the confirmation (`openDiscardDialog`). Only for a file
 * `PlaceChanges.discardable` lists. The dialog is given how many chats work in the place at the moment of the press, and what a discard comes to is read again (`discardChanges`); once
 * one went through and the row or card has gone, the focus goes to the next one (`keepFocusWhenGone`), so it does not fall to the page.
 */
export function DiscardButton({
    model,
    file,
    size = 'xs',
    className,
    tooltipPlacement = 'left',
}: {
    model: PlaceChanges;
    file: GitChangedFile;
    size?: ButtonProps['size'];
    className?: string;
    tooltipPlacement?: ButtonProps['tooltipPlacement'];
}) {
    const root = useRootStore();
    const project = useProjectState();

    return (
        <Button
            variant="filling"
            color="secondary"
            size={size}
            iconOnly
            className={className}
            aria-label={`Discard changes to ${file.path}`}
            tooltip="Discard changes…"
            tooltipPlacement={tooltipPlacement}
            data-discard={file.path}
            onPress={event => {
                // Read at the press, while the row or the card is there to be read.
                const spot = discardSpot(event.target);

                openDiscardDialog({
                    file,
                    working: agentsWorkingIn(project, model.facts.key),
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
