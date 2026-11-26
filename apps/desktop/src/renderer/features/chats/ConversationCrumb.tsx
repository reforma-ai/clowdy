import { Button } from '@clowdy/components/Button';
import { ContentColumn } from '@clowdy/components/ContentColumn';
import { Text } from '@clowdy/components/Text';

import styles from './ConversationCrumb.module.css';

import type { ReactNode } from 'react';

export interface ConversationCrumbProps {
    /** What the line is for a screen reader: `Parent chat`. */
    label: string;
    icon: ReactNode;
    /** What leads the chat's title: `Thread of`. */
    lead: string;
    /** The chat the conversation belongs to. */
    title: string;
    /** Opens that chat. */
    onOpen: () => void;
}

/** The slim line over the stream of a conversation that is not a chat's own: whose it is, and the title of the chat it belongs to, which opens it. */
export function ConversationCrumb({ label, icon, lead, title, onOpen }: ConversationCrumbProps) {
    return (
        <ContentColumn className={styles.crumb}>
            <nav aria-label={label} className={styles.line}>
                <span aria-hidden className={styles.icon}>
                    {icon}
                </span>
                <Text variant="xs" color="secondary">
                    {lead}
                </Text>
                {/* Read as words; the flex gap draws the space. */}{' '}
                <Button variant="inline" color="secondary" className={styles.link} onPress={onOpen}>
                    {title}
                </Button>
            </nav>
        </ContentColumn>
    );
}
