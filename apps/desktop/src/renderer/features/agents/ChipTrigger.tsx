import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { ChevronDown } from '@clowdy/icons/14';
import { use, type ReactNode, type Ref } from 'react';
import { OverlayTriggerStateContext } from 'react-aria-components';

import styles from './ChipTrigger.module.css';

export interface ChipTriggerProps {
    /** The mark at the start of the pill: the folder's, the branch's. Nothing for a pill that is all words. */
    icon?: ReactNode;
    /** Words before the label in the dim tone (`Worktree` before a branch), which stay whole while the label gives way. */
    lead?: string;
    label: string;
    /** Words after the label in the dim tone (`from main` after `New worktree`), which keep their place while a long label is cut. */
    trail?: string;
    /** What a screen reader says of the pill: its kind and the label (`Folder: web`). */
    'aria-label': string;
    tooltip?: string;
    /** In the warning colour: what the pill names is gone. */
    missing?: boolean;
    /** What the pill opens is open, for a list that is not in a trigger's context (a `PickerPopover` drawn beside the pill). Inside a trigger the pill reads it from there. */
    isOpen?: boolean;
    /** The pill's own element, which a list drawn beside it is anchored to. */
    ref?: Ref<HTMLButtonElement | HTMLAnchorElement | null>;
    onPress?: () => void;
}

/**
 * A pill of the line under the message box that opens a menu or a list: its words (`label`, with a dim `lead` before and a dim `trail` after it when it has them) and a chevron, with the plate staying and the chevron turned over while what it opens is
 * there. The folder of a chat and the place it works in (the branch, a new worktree, an existing one) are this pill. It goes inside a `MenuTrigger` or a `PopoverTrigger`, or opens a list of its own by `onPress`.
 */
export function ChipTrigger({ icon, lead, label, trail, 'aria-label': ariaLabel, tooltip, missing = false, isOpen, ref, onPress }: ChipTriggerProps) {
    const trigger = use(OverlayTriggerStateContext);
    const opened = isOpen ?? trigger?.isOpen;

    return (
        <Button
            ref={ ref }
            size="sm"
            variant="filling"
            color={ missing ? 'warning' : undefined }
            rounded
            className={ styles.trigger }
            contentClassName={ styles.triggerContent }
            data-open={ opened || undefined }
            data-missing={ missing || undefined }
            aria-label={ ariaLabel }
            tooltip={ tooltip }
            onPress={ onPress }
        >
            { icon }
            { lead && <Text color="secondary" className={ styles.lead }>{ lead }</Text> }
            <Text truncate className={ trail ? styles.whole : undefined }>{ label }</Text>
            { trail && <Text color="secondary" truncate className={ styles.trail }>{ trail }</Text> }
            <ChevronDown aria-hidden="true" className={ styles.chevron } />
        </Button>
    );
}
