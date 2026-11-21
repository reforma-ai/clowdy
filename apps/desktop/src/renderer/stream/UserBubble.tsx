import { Attachments, PreviewableAttachment } from '@clowdy/components/Attachment';
import { Show } from '@clowdy/components/Show';
import { use } from 'react';

import { Clamp } from './Clamp';
import { Markdown } from './Markdown';
import { MessageActions, type MessageActionsConfig } from './MessageActions';
import { personMarkdown } from './personMarkdown';
import { StreamLinksContext } from './StreamLinks';
import { SwipeHint } from './SwipeHint';
import { useAttachmentPreviews } from './useAttachmentPreviews';
import styles from './UserBubble.module.css';
import { useSwipeReply } from './useSwipeReply';

import type { Attachment } from '@clowdy/protocol';

/** A message longer than this is clamped under a fade until the person opens it. */
const COLLAPSE_MIN_CHARS = 500;

/** The lines a long message shows until it is opened. */
const COLLAPSED_LINES = 16;

export interface UserBubbleProps {
    text: string;
    /** Files the message carries, shown above the text. */
    attachments?: readonly Attachment[];
    /** When it was written, for the time of its row of actions. */
    at: number;
    /** Draws the row of actions under the message (the time it was written, and what it offers); without it the message has none. */
    actions?: MessageActionsConfig;
    /** The message came in while the stream was on screen: it rises into place. */
    animate?: boolean;
    /** The stream item this message is, so the turn rail can scroll to it. */
    turn?: string;
}

/**
 * What the person wrote: a tinted bubble on the right, with a row of actions and the time under it when it is given one. The text is Markdown, as the message box writes it; files and tasks it mentions are chips.
 * The root is marked `data-message`: a selection is quoted by `SelectionReply` only when it lies inside one such element.
 */
export function UserBubble({ text, attachments, at, actions, animate, turn }: UserBubbleProps) {
    const { taskOfKey } = use(StreamLinksContext);
    const previews = useAttachmentPreviews(attachments);
    const body = <Markdown text={ personMarkdown(text, taskOfKey) } fromPerson />;
    // A swipe is the Reply button's other way in: it needs the same handler and words.
    const swipes = Boolean(actions?.onReply && actions.swipeToReply && text.trim() !== '');
    const row = useSwipeReply<HTMLDivElement>({ enabled: swipes, onReply: () => actions?.onReply?.(text) });

    return (
        <div ref={ row } className={ styles.row } data-animate={ animate || undefined } data-turn={ turn } data-message="">
            { /* Before the row of actions, which stays the last child of the message (see `MessageActions`). */ }
            <Show when={ swipes }>
                <SwipeHint />
            </Show>
            <Show when={ attachments?.length }>
                <Attachments size="sm" className={ styles.files }>
                    { attachments?.map(attachment => (
                        <PreviewableAttachment
                            key={ attachment.id }
                            data={ { id: attachment.id, filename: attachment.name, mediaType: attachment.mediaType, size: attachment.size, preview: previews.get(attachment.id) } }
                        />
                    )) }
                </Attachments>
            </Show>
            <Show when={ text.trim() !== '' }>
                <div className={ styles.bubble }>
                    <Show when={ text.length > COLLAPSE_MIN_CHARS } fallback={ body }>
                        <Clamp lines={ COLLAPSED_LINES } moreLabel="Show full message">{ body }</Clamp>
                    </Show>
                </div>
            </Show>
            <Show when={ actions }>
                { config => <MessageActions text={ text } at={ at } align="end" actions={ config } /> }
            </Show>
        </div>
    );
}
