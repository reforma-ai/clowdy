import { ChevronDown } from '@clowdy/icons/8';
import {
    Bold,
    Checkbox,
    CodeBraces,
    H1,
    H2,
    H3,
    H4,
    H5,
    H6,
    Italic,
    Link,
    List,
    ListNumbered,
    Pilcrow,
    Quote,
    Strikethrough2,
} from '@clowdy/icons/14';
import { useEditorState } from '@tiptap/react';
import { type ComponentType, type FormEvent, Fragment, use, useState } from 'react';
import { Toolbar } from 'react-aria-components';

import { Button } from '../Button';
import { For } from '../For';
import { Hotkey, tooltipWithHotkey } from '../Hotkey';
import { Input } from '../Input';
import { Menu, MenuItem, MenuTrigger } from '../List';
import { OverlayTriggerStateContext, Popover, PopoverTrigger } from '../Popover';
import { Separator } from '../Separator';
import { Show } from '../Show';
import styles from './MarkdownEditor.module.css';

import type { ChainedCommands, Editor } from '@tiptap/core';

interface FormatAction {
    label: string;
    /** The shortcut the editor gives the command: TipTap's default, or the one `markdownDocument.ts` sets in its place. */
    hotkey: string[];
    icon: ComponentType;
    isActive: (editor: Editor) => boolean;
    run: (chain: ChainedCommands) => ChainedCommands;
}

// The menu sets the style; TipTap's heading shortcuts toggle it.
const TEXT_STYLES: FormatAction[] = [
    {
        label: 'Text',
        hotkey: ['mod', 'alt', '0'],
        icon: Pilcrow,
        isActive: editor => editor.isActive('paragraph'),
        run: chain => chain.setParagraph(),
    },
    ...[H1, H2, H3, H4, H5, H6].map((icon, index): FormatAction => {
        const level = (index + 1) as 1 | 2 | 3 | 4 | 5 | 6;

        return {
            label: `Heading ${level}`,
            hotkey: ['mod', 'alt', String(level)],
            icon,
            isActive: editor => editor.isActive('heading', { level }),
            run: chain => chain.setHeading({ level }),
        };
    }),
];

const GROUPS: FormatAction[][] = [
    [
        {
            label: 'Bold',
            hotkey: ['mod', 'b'],
            icon: Bold,
            isActive: editor => editor.isActive('bold'),
            run: chain => chain.toggleBold(),
        },
        {
            label: 'Italic',
            hotkey: ['mod', 'i'],
            icon: Italic,
            isActive: editor => editor.isActive('italic'),
            run: chain => chain.toggleItalic(),
        },
        {
            label: 'Strikethrough',
            hotkey: ['mod', 'shift', 's'],
            icon: Strikethrough2,
            isActive: editor => editor.isActive('strike'),
            run: chain => chain.toggleStrike(),
        },
    ],
    [
        {
            label: 'Bulleted list',
            hotkey: ['mod', 'shift', '8'],
            icon: List,
            isActive: editor => editor.isActive('bulletList'),
            run: chain => chain.toggleBulletList(),
        },
        {
            label: 'Numbered list',
            hotkey: ['mod', 'shift', '7'],
            icon: ListNumbered,
            isActive: editor => editor.isActive('orderedList'),
            run: chain => chain.toggleOrderedList(),
        },
        {
            label: 'Task list',
            hotkey: ['mod', 'shift', '9'],
            icon: Checkbox,
            isActive: editor => editor.isActive('taskList'),
            run: chain => chain.toggleTaskList(),
        },
    ],
    [
        {
            label: 'Quote',
            hotkey: ['mod', 'shift', '.'],
            icon: Quote,
            isActive: editor => editor.isActive('blockquote'),
            run: chain => chain.toggleBlockquote(),
        },
        {
            label: 'Code block',
            hotkey: ['mod', 'alt', 'c'],
            icon: CodeBraces,
            isActive: editor => editor.isActive('codeBlock'),
            run: chain => chain.toggleCodeBlock(),
        },
    ],
];

/** Block and inline formatting for {@link MarkdownEditor}, with the state at the cursor. */
export function MarkdownToolbar({ editor }: { editor: Editor }) {
    const state = useEditorState({
        editor,
        selector: ({ editor: current }) => ({
            style: TEXT_STYLES.find(style => style.isActive(current)),
            active: GROUPS.map(group => group.map(action => action.isActive(current))),
            link: current.isActive('link'),
        }),
    });
    const StyleIcon = state.style?.icon ?? Pilcrow;

    return (
        <Toolbar aria-label="Formatting" className={styles.toolbar}>
            <MenuTrigger>
                <Button variant="filling" color="secondary" size="sm" aria-label="Text style" tooltip="Text style">
                    <StyleIcon />
                    <ChevronDown />
                </Button>

                <Popover placement="bottom start" spacing="xs">
                    <Menu
                        aria-label="Text style"
                        size="sm"
                        selectionMode="single"
                        selectedKeys={state.style ? [state.style.label] : []}
                        onAction={key =>
                            TEXT_STYLES.find(style => style.label === key)!
                                .run(editor.chain().focus())
                                .run()
                        }
                    >
                        <For each={TEXT_STYLES}>
                            {style => (
                                <MenuItem
                                    key={style.label}
                                    id={style.label}
                                    text={style.label}
                                    icon={<style.icon />}
                                    endAffix={<Hotkey hotkey={style.hotkey} />}
                                />
                            )}
                        </For>
                    </Menu>
                </Popover>
            </MenuTrigger>

            <For each={GROUPS}>
                {(group, groupIndex) => (
                    <Fragment key={group[0]!.label}>
                        <Separator orientation="vertical" spacing="xxs" />

                        <For each={group}>
                            {(action, index) => (
                                <Button
                                    key={action.label}
                                    variant="filling"
                                    color="secondary"
                                    size="sm"
                                    iconOnly
                                    aria-label={action.label}
                                    tooltip={tooltipWithHotkey(action.label, action.hotkey)}
                                    isPressed={state.active[groupIndex]![index]!}
                                    onPress={() => action.run(editor.chain().focus()).run()}
                                >
                                    <action.icon />
                                </Button>
                            )}
                        </For>
                    </Fragment>
                )}
            </For>

            <Separator orientation="vertical" spacing="xxs" />

            <PopoverTrigger>
                <Button
                    variant="filling"
                    color="secondary"
                    size="sm"
                    iconOnly
                    aria-label="Link"
                    tooltip="Link"
                    isPressed={state.link}
                >
                    <Link />
                </Button>

                <Popover placement="bottom start">
                    <LinkForm editor={editor} isLink={state.link} />
                </Popover>
            </PopoverTrigger>
        </Toolbar>
    );
}

function LinkForm({ editor, isLink }: { editor: Editor; isLink: boolean }) {
    const overlay = use(OverlayTriggerStateContext)!;
    const [href, setHref] = useState(() => String(editor.getAttributes('link').href ?? ''));

    const apply = (next: string) => {
        // TipTap focuses on the next frame, after the popover hands focus back to its trigger.
        const chain = editor.chain().focus().extendMarkRange('link');

        if (!next) {
            chain.unsetLink();
        } else if (editor.state.selection.empty && !isLink) {
            chain.insertContent({ type: 'text', text: next, marks: [{ type: 'link', attrs: { href: next } }] });
        } else {
            chain.setLink({ href: next });
        }

        chain.run();
        overlay.close();
    };

    const submit = (event: FormEvent) => {
        event.preventDefault();
        apply(href.trim());
    };

    return (
        <form className={styles.linkForm} onSubmit={submit}>
            <Input
                className={styles.linkInput}
                type="text"
                size="sm"
                aria-label="URL"
                placeholder="https://"
                value={href}
                autoFocus
                onChange={setHref}
            />

            <Show when={isLink}>
                <Button variant="transparent" color="secondary" size="sm" onPress={() => apply('')}>
                    Remove
                </Button>
            </Show>

            <Button type="submit" size="sm">
                Apply
            </Button>
        </form>
    );
}
