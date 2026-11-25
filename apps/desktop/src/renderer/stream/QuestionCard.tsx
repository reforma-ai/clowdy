import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { GridList, GridListItem, useCellEditMode } from '@clowdy/components/List';
import { Show } from '@clowdy/components/Show';
import { Text } from '@clowdy/components/Text';
import { Textarea } from '@clowdy/components/Textarea';
import { Edit } from '@clowdy/icons/12';
import { Check } from '@clowdy/icons/14';
import { SendBold } from '@clowdy/icons/16';
import { useRef, useState } from 'react';

import styles from './QuestionCard.module.css';
import { splitQuestion } from './questionParts';

import type { StreamItemBody } from '@clowdy/protocol';
import type { FocusEvent, PointerEvent } from 'react';
import type { Selection } from 'react-aria-components';

type QuestionBody = Extract<StreamItemBody, { kind: 'question' }>;

/** The row with the field for the person's own words; an option's id is a slug, so it never meets this one. */
const CUSTOM_ID = '~custom';

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
 * A question the run waits on (semi-manual mode): the options as numbered rows with what each one means, the
 * recommended one preselected, a row with a field for another answer, and the send button. Once answered it
 * shows the answer instead.
 */
export function QuestionCard({ question, onAnswer }: QuestionCardProps) {
    const { text, options, recommended, answer, state } = question;
    const [selected, setSelected] = useState(recommended ?? options[0]?.id ?? CUSTOM_ID);
    const [custom, setCustom] = useState('');
    const [isPending, setIsPending] = useState(false);
    const fieldRef = useRef<HTMLTextAreaElement>(null);
    const chosen = options.find(option => option.id === selected);
    const reply = selected === CUSTOM_ID ? custom.trim() : chosen?.label;

    const submit = async () => {
        if (!reply || !onAnswer || isPending) return;

        setIsPending(true);

        try {
            await onAnswer(reply);
        } finally {
            setIsPending(false);
        }
    };

    // Enter in the field sends, Shift+Enter starts a new line. The list's own key handling cannot see the field.
    const cellEditProps = useCellEditMode(event => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;

        event.preventDefault();

        if (!event.repeat) void submit();
    }, fieldRef);

    const select = (id: string) => {
        setSelected(id);

        if (id === CUSTOM_ID) requestAnimationFrame(() => fieldRef.current?.focus({ preventScroll: true }));
    };

    // Reaching into the field picks its row, and the list must not take the press for a toggle of its own.
    const pickField = (event: PointerEvent<Element> | FocusEvent<Element>) => {
        event.stopPropagation();
        setSelected(CUSTOM_ID);
    };

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

    const { title, paragraphs } = splitQuestion(text);

    return (
        <form
            className={styles.card}
            onSubmit={event => {
                event.preventDefault();
                void submit();
            }}
        >
            <div className={styles.header}>
                <Text variant="label" weight="medium" wrap="anywhere">
                    {title}
                </Text>
            </div>

            <Show when={paragraphs.length > 0}>
                <div className={styles.facts}>
                    <For each={paragraphs}>
                        {paragraph => (
                            <Text key={paragraph} variant="sm" color="secondary" whitespace="pre-line">
                                {paragraph}
                            </Text>
                        )}
                    </For>
                </div>
            </Show>

            <GridList
                className={styles.options}
                aria-label={title}
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[selected]}
                keyboardNavigationBehavior="tab"
                onSelectionChange={(keys: Selection) => {
                    const [key] = keys === 'all' ? [] : keys;

                    if (key !== undefined) select(String(key));
                }}
            >
                <For each={options}>
                    {(option, index) => (
                        <GridListItem
                            key={option.id}
                            id={option.id}
                            className={styles.option}
                            align="start"
                            scrollActive={false}
                            textValue={option.label}
                        >
                            <Text slot="icon" variant="sm" className={styles.number} aria-hidden>
                                {index + 1}
                            </Text>
                            <Box slot="label" className={styles.body}>
                                <span className={styles.labelLine}>
                                    {option.label}
                                    <Show when={option.id === recommended}>
                                        <span className={styles.recommended}>Recommended</span>
                                    </Show>
                                </span>
                                <Show when={option.consequence}>
                                    {consequence => (
                                        <Text variant="sm" color="secondary">
                                            {consequence}
                                        </Text>
                                    )}
                                </Show>
                            </Box>
                        </GridListItem>
                    )}
                </For>
                <GridListItem
                    id={CUSTOM_ID}
                    className={styles.option}
                    scrollActive={false}
                    textValue="Your own answer"
                    data-field=""
                >
                    <Text slot="icon" variant="sm" className={styles.number} aria-hidden>
                        <Edit />
                    </Text>
                    <Textarea
                        slot="label"
                        variant="inline"
                        size="sm"
                        autoResize
                        rows={1}
                        className={styles.body}
                        textareaClassName={styles.field}
                        aria-label="Your own answer"
                        placeholder="Or write your own answer"
                        ref={fieldRef}
                        value={custom}
                        onChange={setCustom}
                        {...cellEditProps}
                        onPointerDown={pickField}
                        onFocus={event => {
                            cellEditProps.onFocus(event);
                            pickField(event);
                        }}
                    />
                </GridListItem>
            </GridList>

            <div className={styles.footer}>
                <Button
                    type="submit"
                    color="primary"
                    size="sm"
                    iconOnly
                    rounded
                    isDisabled={!reply || !onAnswer}
                    isPending={isPending}
                    aria-label="Next"
                    tooltip="Next"
                >
                    <SendBold />
                </Button>
            </div>
        </form>
    );
}
