import { Button } from '@clowdy/components/Button';
import { Input } from '@clowdy/components/Input';
import { Radio, RadioGroup } from '@clowdy/components/Radio';
import { Text } from '@clowdy/components/Text';
import { Check } from '@clowdy/icons/14';
import { useState } from 'react';

import styles from './QuestionCard.module.css';
import { splitQuestion } from './questionParts';

import type { StreamItemBody } from '@clowdy/protocol';

type QuestionBody = Extract<StreamItemBody, { kind: 'question' }>;

export interface QuestionCardProps {
    question: QuestionBody;
    /** Called with the label of the chosen option, or the person's own words. Without it the card is read-only. */
    onAnswer?: (answer: string) => void | Promise<void>;
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
 * A question the run waits on (semi-manual mode): the options with what each one means, the recommended one
 * preselected, a field for another answer, and "Next". Once answered it shows the answer instead.
 */
export function QuestionCard({ question, onAnswer }: QuestionCardProps) {
    const { text, options, recommended, answer, state } = question;
    const [selected, setSelected] = useState<string | null>(recommended ?? options[0]?.id ?? null);
    const [custom, setCustom] = useState('');
    const [isPending, setIsPending] = useState(false);
    const chosen = options.find(option => option.id === selected);
    const reply = custom.trim() || chosen?.label;

    if (answer !== undefined) {
        return (
            <div className={styles.card} data-answered>
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
            <div className={styles.card}>
                <QuestionText text={text} />
                <Text color="secondary">{state === 'expired' ? 'Question expired' : 'Question withdrawn'}</Text>
            </div>
        );
    }

    const submit = async () => {
        if (!reply || !onAnswer || isPending) return;

        setIsPending(true);

        try {
            await onAnswer(reply);
        } finally {
            setIsPending(false);
        }
    };

    return (
        <form
            className={styles.card}
            onSubmit={event => {
                event.preventDefault();
                void submit();
            }}
        >
            <QuestionText text={text} />

            <RadioGroup
                aria-label={splitQuestion(text).title}
                value={custom.trim() ? '' : (selected ?? '')}
                onChange={value => {
                    setSelected(value);
                    setCustom('');
                }}
                className={styles.options}
            >
                {options.map(option => (
                    <Radio key={option.id} value={option.id} className={styles.option}>
                        <span className={styles.label}>
                            <span className={styles.labelLine}>
                                {option.label}
                                {option.id === recommended && <span className={styles.recommended}>Recommended</span>}
                            </span>
                            {option.consequence && (
                                <Text variant="sm" color="secondary">
                                    {option.consequence}
                                </Text>
                            )}
                        </span>
                    </Radio>
                ))}
            </RadioGroup>

            <Input
                type="text"
                aria-label="Your own answer"
                placeholder="Or write your own answer"
                value={custom}
                onChange={setCustom}
            />

            <div className={styles.actions}>
                <Button type="submit" color="primary" isDisabled={!reply || !onAnswer} isPending={isPending}>
                    Next
                </Button>
            </div>
        </form>
    );
}
