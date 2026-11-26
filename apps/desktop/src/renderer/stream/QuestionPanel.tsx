import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { GridList, GridListItem, useCellEditMode } from '@clowdy/components/List';
import { Show } from '@clowdy/components/Show';
import { Text } from '@clowdy/components/Text';
import { Textarea } from '@clowdy/components/Textarea';
import { Edit } from '@clowdy/icons/12';
import { SendBold } from '@clowdy/icons/16';
import { useRef, useState } from 'react';

import styles from './QuestionPanel.module.css';
import { SKIPPED_ANSWER, splitQuestion } from './questionParts';

import type { StreamItemBody } from '@clowdy/protocol';
import type { FocusEvent, PointerEvent } from 'react';
import type { Selection } from 'react-aria-components';

type QuestionBody = Extract<StreamItemBody, { kind: 'question' }>;

/** The row with the field for the person's own words; an option's id is a slug, so it never meets this one. */
const CUSTOM_ID = '~custom';

export interface QuestionPanelProps {
    question: QuestionBody;
    /** Called with the label of the chosen option, the person's own words, or `Skipped`. Without it the panel is read-only. */
    onAnswer?: (answer: string) => void | Promise<void>;
}

/**
 * The form of a question the run waits on (semi-manual mode), without a frame of its own: the title, the facts, the options as numbered
 * rows with what each one means, the recommended one preselected, a row with a field for another answer, Skip at the start of the line under
 * them and the send button at its end. The box under the chat draws it in place of the message field; `QuestionCard` frames it in the stream
 * where the box cannot.
 */
export function QuestionPanel({ question, onAnswer }: QuestionPanelProps) {
    const { text, options, recommended } = question;
    const { title, paragraphs } = splitQuestion(text);
    const [selected, setSelected] = useState(recommended ?? options[0]?.id ?? CUSTOM_ID);
    const [custom, setCustom] = useState('');
    const [isPending, setIsPending] = useState(false);
    const fieldRef = useRef<HTMLTextAreaElement>(null);
    const chosen = options.find(option => option.id === selected);
    const reply = selected === CUSTOM_ID ? custom.trim() : chosen?.label;

    const answer = async (given: string | undefined) => {
        if (!given || !onAnswer || isPending) return;

        setIsPending(true);

        try {
            await onAnswer(given);
        } finally {
            setIsPending(false);
        }
    };

    // Enter in the field sends, Shift+Enter starts a new line. The list's own key handling cannot see the field.
    const cellEditProps = useCellEditMode(event => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;

        event.preventDefault();

        if (!event.repeat) void answer(reply);
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

    return (
        <form
            className={styles.panel}
            onSubmit={event => {
                event.preventDefault();
                void answer(reply);
            }}
        >
            <div className={styles.header}>
                <Text variant="md" weight="medium" wrap="anywhere" whitespace="pre-line">
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
                    size="sm"
                    variant="filling"
                    isDisabled={!onAnswer || isPending}
                    onPress={() => void answer(SKIPPED_ANSWER)}
                >
                    Skip
                </Button>
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
