import { use } from 'react';

import { SkillChip } from '../../../features/chats/MentionChip';
import { StreamLinksContext } from '../../StreamLinks';
import { isFilePathLike, normalizeFileReferencePath } from '../codeCitation';
import { FileChip } from '../FileChip';
import { sanitizeStreamdownProps } from '../sanitizeStreamdownProps';
import { TaskKeyChip } from '../TaskKeyChip';

import type { ComponentProps } from 'react';
import type { ExtraProps } from 'streamdown';

type StreamdownInlineCodeProps = ComponentProps<'code'> & ExtraProps;

/** Inline backtick code: a task of the project becomes a task chip, a path in the project a file chip (not the project folder itself), a skill of the person's a skill chip. */
export function StreamdownInlineCode(props: StreamdownInlineCodeProps) {
    const { children, ...rest } = sanitizeStreamdownProps(props);
    const { taskOfKey, skillOfName } = use(StreamLinksContext);
    const text = children?.toString() ?? '';
    const task = taskOfKey?.(text.trim());

    if (task) {
        return (
            <span data-streamdown="inline-code-chip">
                <TaskKeyChip task={task} />
            </span>
        );
    }

    const skill = text.startsWith('/') ? skillOfName?.(text.slice(1)) : undefined;

    if (skill) {
        return (
            <span data-streamdown="inline-code-chip">
                <SkillChip name={skill.name} description={skill.description} />
            </span>
        );
    }

    const path = normalizeFileReferencePath(text);

    if (isFilePathLike(path)) {
        return (
            <span data-streamdown="inline-code-chip">
                <FileChip path={path} />
            </span>
        );
    }

    return (
        <code data-streamdown="inline-code" {...rest}>
            {children}
        </code>
    );
}
