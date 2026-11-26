import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { GridList, GridListItem, useCellEditMode } from '@clowdy/components/List';
import { Show } from '@clowdy/components/Show';
import { Text } from '@clowdy/components/Text';
import { Textarea } from '@clowdy/components/Textarea';
import { TooltipContent, TooltipTrigger } from '@clowdy/components/Tooltip';
import { Edit } from '@clowdy/icons/12';
import { CircleCheck } from '@clowdy/icons/14';
import { SendBold } from '@clowdy/icons/16';
import { useRef, useState } from 'react';
import { Focusable } from 'react-aria-components';

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
    /** The panel stands in the box under the chat, where it may not take more than half of the window: the question and the options scroll inside it, and Skip and send stay in sight. */
    bounded?: boolean;
}

/** The label of the option the agent recommends, with a check mark after it whose tip says so. The mark sticks to the last word, so it never wraps onto a line of its own. */
function WithRecommendedMark({ label }: { label: string }) {
    const split = label.lastIndexOf(' ') + 1;

    return (
        <>
            {label.slice(0, split)}
            <span className={styles.tail}>
                {label.slice(split)}
                <TooltipTrigger>
                    {/* The tip is for the pointer: the mark is no stop of its own in the list, and its meaning is in the name. */}
                    <Focusable excludeFromTabOrder>
                        <span className={styles.recommended} role="img" aria-label="Recommended option">
                            <CircleCheck aria-hidden />
                        </span>
                    </Focusable>
                    <TooltipContent>Recommended option</TooltipContent>
                </TooltipTrigger>
            </span>
        </>
    );
}

/**
 * The form of a question the run waits on (semi-manual mode), without a frame of its own: the title, the facts, the options as numbered
 * rows with what each one means, the recommended one preselected, a row with a field for another answer, Skip at the start of the line under
 * them and the send button at its end. The box under the chat draws it in place of the message field; `QuestionCard` frames it in the stream
 * where the box cannot.
 */
export function QuestionPanel({ question, onAnswer, bounded }: QuestionPanelProps) {
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

    // The words of an option can be selected, to carry a piece of one into the person's own answer. While a row is pressed the library keeps text from being
    // selected, so a press on the words does not reach the row, and a click that left nothing selected picks it instead.
    const keepFromRow = (event: PointerEvent<Element>) => event.stopPropagation();
    const pickUnlessSelecting = (id: string) => {
        if (!window.getSelection()?.toString()) select(id);
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
            <div className={styles.scroll} data-bounded={bounded || undefined}>
                <div className={styles.head}>
                    <Text variant="md" weight="medium" wrap="anywhere" whitespace="pre-line">
                        {title}
                    </Text>
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
                </div>

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
                                <Box
                                    slot="label"
                                    className={styles.body}
                                    onPointerDown={keepFromRow}
                                    onClick={() => pickUnlessSelecting(option.id)}
                                >
                                    <span>
                                        {option.id === recommended ? (
                                            <WithRecommendedMark label={option.label} />
                                        ) : (
                                            option.label
                                        )}
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
                        align="start"
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
            </div>

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
