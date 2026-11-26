import { Message } from '@clowdy/icons/14';
import { use } from 'react';

import styles from '../../shared/Chip.module.css';
import { StreamLinksContext } from '../StreamLinks';

import type { Chat } from '@clowdy/protocol';

/** A chat referenced in a message, using its current title rather than the stored ID. */
export function ChatReferenceChip({ chat }: { chat: Pick<Chat, 'id' | 'title'> }) {
    const { onOpenChat } = use(StreamLinksContext);
    const contents = (
        <>
            <span className={styles.icon}>
                <Message width={12} height={12} />
            </span>
            <span className={styles.label}>{chat.title}</span>
        </>
    );

    if (!onOpenChat) return <span className={styles.chip}>{contents}</span>;

    return (
        <button type="button" className={styles.chip} title={chat.title} onClick={() => onOpenChat(chat.id)}>
            {contents}
        </button>
    );
}
