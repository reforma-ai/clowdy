import { Text } from '@clowdy/components/Text';
import { Check } from '@clowdy/icons/14';

import styles from './QuestionCard.module.css';
import { QuestionPanel } from './QuestionPanel';
import { splitQuestion } from './questionParts';

import type { StreamItemBody } from '@clowdy/protocol';

type QuestionBody = Extract<StreamItemBody, { kind: 'question' }>;

export interface QuestionCardProps {
    question: QuestionBody;
    /** Called with the label of the chosen option, or the person's own words. Without it the card is read-only. */
    onAnswer?: (answer: string) => void | Promise<void>;
    /** The box under the chat draws this question's form in place of its message field, so the card is only a line saying so. */
    docked?: boolean;
}

/** The question as a title, then its facts and "My pick" as quieter paragraphs. */
function QuestionText({ text }: { text: string }) {
    const { title, paragraphs } = splitQuestion(text);

    return (
        <div className={styles.text}>
            <Text weight="medium">{title}</Text>
            {paragraphs.map(paragraph => (
                <Text key={paragraph} color="secondary" whitespace="pre-line">
                    {paragraph}
                </Text>
            ))}
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
            <div className={styles.card} data-plain data-answered>
                <QuestionText text={text} />
                <div className={styles.answer}>
                    <Check aria-hidden />
                    <Text color="secondary">{answer}</Text>
                </div>
            </div>
        );
    }

    if (state) {
        return (
            <div className={styles.card} data-plain>
                <QuestionText text={text} />
                <Text color="secondary">
                    {state === 'preparing'
                        ? 'Stopping the agent…'
                        : state === 'expired'
                          ? 'Question expired'
                          : 'Question withdrawn'}
                </Text>
            </div>
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
