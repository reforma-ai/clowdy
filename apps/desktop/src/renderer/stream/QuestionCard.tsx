import { Show } from '@clowdy/components/Show';
import { Text } from '@clowdy/components/Text';
import { Message } from '@clowdy/icons/14';

import styles from './QuestionCard.module.css';
import { QuestionPanel } from './QuestionPanel';
import { splitQuestion } from './questionParts';

import type { StreamItemBody } from '@clowdy/protocol';
import type { ReactNode } from 'react';

type QuestionBody = Extract<StreamItemBody, { kind: 'question' }>;

export interface QuestionCardProps {
    question: QuestionBody;
    /** Called with the label of the chosen option, or the person's own words. Without it the card is read-only. */
    onAnswer?: (answer: string) => void | Promise<void>;
    /** The box under the chat draws this question's form in place of its message field, so the card is only a line saying so. */
    docked?: boolean;
}

/**
 * A question that is over (Reforma's answer card): a message mark and a header, then under a rule the question at two lines, what it was about
 * at three (the facts and the agent's pick, run together), and what came of it. It is a reminder, so none of it opens: the question was
 * read in full when it was asked.
 */
function SettledCard({ header, text, children }: { header: string; text: string; children: ReactNode }) {
    const { title, paragraphs } = splitQuestion(text);

    return (
        <div className={styles.settled}>
            <div className={styles.settledHeader}>
                <Message className={styles.settledIcon} aria-hidden />
                <Text variant="sm" weight="medium">
                    {header}
                </Text>
            </div>
            <div className={styles.settledBody}>
                <Text variant="label" color="secondary" className={styles.asked}>
                    {title}
                </Text>
                <Show when={paragraphs.length > 0}>
                    <Text variant="sm" color="secondary" whitespace="pre-line" className={styles.described}>
                        {paragraphs.join('\n')}
                    </Text>
                </Show>
                {children}
            </div>
        </div>
    );
}

/**
 * A question in the stream (semi-manual mode). While the run waits on it the box under the chat holds its form (`QuestionPanel`) and the card is
 * a quiet line saying so; where the box cannot (a question nobody can answer any more, a chat that is read only) the card frames the form itself.
 * Once answered it shows the answer instead.
 */
export function QuestionCard({ question, onAnswer, docked }: QuestionCardProps) {
    const { text, answer, state } = question;
    if (answer !== undefined) {
        return (
            <SettledCard header="Answer" text={text}>
                <Text variant="sm" wrap="anywhere" whitespace="pre-line">
                    {answer}
                </Text>
            </SettledCard>
        );
    }

    if (state) {
        return (
            <SettledCard header="Question" text={text}>
                <Text variant="sm" color="secondary">
                    {state === 'preparing'
                        ? 'Stopping the agent…'
                        : state === 'expired'
                          ? 'Question expired'
                          : 'Question withdrawn'}
                </Text>
            </SettledCard>
        );
    }

    if (docked) {
        return (
            <Text color="secondary" className={styles.docked}>
                Answer in the box below
            </Text>
        );
    }

    return (
        <div className={styles.card}>
            <QuestionPanel question={question} onAnswer={onAnswer} />
        </div>
    );
}
