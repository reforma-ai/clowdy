import { Button } from '@clowdy/components/Button';
import { Undo } from '@clowdy/icons/14';

import { useProjectState, useRootStore } from '../../stores';
import { openDiscardDialog } from './DiscardDialog';
import { discardChanges } from './discardChanges';
import { agentsWorkingIn } from './discardRules';

import type { ButtonProps } from '@clowdy/components/Button';
import type { GitChangedFile } from '@clowdy/protocol';
import type { PlaceChanges } from './PlaceChanges';

/**
 * `Discard changes…` for one file of the place: a small icon button that its row or card header shows when the pointer is over it or the focus is in it (the CSS of the host does that, so a
 * keyboard reaches it with Tab and it is never a surprise under the pointer), which opens the confirmation (`openDiscardDialog`). Only for a file `PlaceChanges.discardable` lists. The dialog is
 * given how many chats work in the place at the moment of the press, and what a discard comes to is read again (`discardChanges`).
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
            variant="transparent"
            color="secondary"
            size={size}
            iconOnly
            className={className}
            aria-label={`Discard changes to ${file.path}`}
            tooltip="Discard changes…"
            tooltipPlacement={tooltipPlacement}
            data-discard={file.path}
            onPress={() =>
                openDiscardDialog({
                    file,
                    working: agentsWorkingIn(project, model.facts.key),
                    discard: () => discardChanges(model, root.transport, file.path),
                })
            }
        >
            <Undo aria-hidden="true" />
        </Button>
    );
}
