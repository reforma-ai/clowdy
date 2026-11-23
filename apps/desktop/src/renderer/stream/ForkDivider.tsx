import { Button } from '@clowdy/components/Button';
import { Marker, MarkerContent } from '@clowdy/components/Marker';
import { Show } from '@clowdy/components/Show';
import { inlineLink } from '@clowdy/components/Text';
import { cn } from '@clowdy/lib';

import styles from './ForkDivider.module.css';

/** Where a forked chat's conversation came from, and where the history it inherited ends. */
export interface ForkOrigin {
    /** The `seq` of the last item the chat inherited: the divider is drawn right after it. */
    atSeq: number;
    /** The source chat's title, while the app still has the chat. */
    title?: string;
    /** Opens the source chat. Given only while it can be opened: it is still there and not in the archive. */
    onOpen?: () => void;
}

/**
 * The line in the message list where a fork's own conversation starts: `Forked from <source title>`, the title opening the source chat while it can be
 * opened. A source that is in the archive is named but not opened (opening it would bring it back), and one that is gone leaves `Forked` alone.
 */
export function ForkDivider({ title, onOpen }: Omit<ForkOrigin, 'atSeq'>) {
    return (
        <Marker variant="separator" data-slot="fork-divider">
            <MarkerContent className={styles.words}>
                <Show when={title !== undefined} fallback="Forked">
                    Forked from
                    {/* Read as words; the title is a button when it opens the chat. */}{' '}
                    <Show when={onOpen} fallback={<span>{title}</span>}>
                        {open => (
                            <Button variant="inline" className={cn(inlineLink, styles.title)} onPress={open}>
                                {title}
                            </Button>
                        )}
                    </Show>
                </Show>
            </MarkerContent>
        </Marker>
    );
}
