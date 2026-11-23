import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { GITHUB_URL } from '@clowdy/constants';
import { Close } from '@clowdy/icons/14';
import { Github } from '@clowdy/icons/logo';

import { useProjectState, useRootStore } from '../../stores';
import styles from './StarCard.module.css';
import { starCardDue, starCardPreferences } from './starCardState';

/**
 * The card at the bottom of the chat list that asks for a star on GitHub: once, after the person has been using Clowdy a while (`starCardDue`). The button opens the repository
 * and the cross only shuts the card; both close it for good (`starCardPreferences`).
 */
export function StarCard() {
    const root = useRootStore();
    const project = useProjectState();

    // The projects and the chats are read only while the card is open: a closed card follows nothing but its flag, so a chat changing does not draw it again.
    if (
        starCardPreferences.dismissed ||
        !starCardDue({ projects: root.projects, chats: project.chatList, now: Date.now() })
    )
        return null;

    return (
        // Not an `aside`: the list is one, and a complementary landmark inside another is flagged by accessibility checkers.
        <section className={styles.card} aria-label="Star on GitHub">
            <div className={styles.header}>
                <Text variant="sm" weight="medium">
                    Having a good time with Clowdy?
                </Text>
                <Button
                    variant="filling"
                    size="xs"
                    iconOnly
                    aria-label="Close"
                    onPress={() => starCardPreferences.dismiss()}
                >
                    <Close />
                </Button>
            </div>
            <Text variant="sm" color="secondary">
                A star on GitHub helps us grow
            </Text>
            <Button
                variant="filled"
                color="primary"
                size="sm"
                className={styles.star}
                onPress={() => {
                    // The same way a link opens, through the window's open handler, which hands it to the browser: the card goes with the press, and a link that left with it would not open.
                    window.open(GITHUB_URL, '_blank', 'noreferrer');
                    starCardPreferences.dismiss();
                }}
            >
                <Github size={14} />
                Star on GitHub
            </Button>
        </section>
    );
}
