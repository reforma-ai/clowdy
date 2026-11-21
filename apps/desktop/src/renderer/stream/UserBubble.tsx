import { Attachments, PreviewableAttachment } from '@clowdy/components/Attachment';
import { Show } from '@clowdy/components/Show';
import { use } from 'react';

import { Clamp } from './Clamp';
import { Markdown } from './Markdown';
import { MessageActions, type MessageActionsShow } from './MessageActions';
import { personMarkdown } from './personMarkdown';
import { StreamLinksContext } from './StreamLinks';
import { useAttachmentPreviews } from './useAttachmentPreviews';
import styles from './UserBubble.module.css';

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
    /** Draws the row of actions under the message (copy, and the time it was written); without it the message has none. */
    actions?: MessageActionsShow;
    /** The message came in while the stream was on screen: it rises into place. */
    animate?: boolean;
    /** The stream item this message is, so the turn rail can scroll to it. */
    turn?: string;
}

/** What the person wrote: a tinted bubble on the right, with a row of actions and the time under it when it is given one. The text is Markdown, as the message box writes it; files and tasks it mentions are chips. */
export function UserBubble({ text, attachments, at, actions, animate, turn }: UserBubbleProps) {
    const { taskOfKey } = use(StreamLinksContext);
    const previews = useAttachmentPreviews(attachments);
    const body = <Markdown text={ personMarkdown(text, taskOfKey) } fromPerson />;

    return (
        <div className={ styles.row } data-animate={ animate || undefined } data-turn={ turn }>
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
                { show => <MessageActions text={ text } at={ at } align="end" show={ show } /> }
            </Show>
        </div>
    );
}
