import { Button } from '@clowdy/components/Button';
import { ConfirmButton } from '@clowdy/components/ConfirmButton';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { formatFullTime, formatMessageTime } from '../../shared/time';
import { Markdown } from '../../stream/Markdown';
import styles from './Comment.module.css';
import { CommentEditor } from './CommentEditor';

import type { TaskComment } from '@clowdy/protocol';

export interface CommentProps {
    comment: TaskComment;
    /** Who wrote it, as the line says it (`CommentsSection` decides what an agent is called and whether it is a link). */
    author: ReactNode;
    /** The comment is the person's own: only then it has Edit and Delete. An agent's is read only here, though the commands would take it. */
    isOwn: boolean;
    /** Saves the new body; resolves to whether the daemon took it. */
    onEdit: (body: string) => Promise<boolean>;
    /** Deletes the comment, after the person confirmed. */
    onDelete: () => Promise<void>;
}

/**
 * One comment: who wrote it, when, `edited` when its body was changed, and the Markdown. The person's own has Edit, which swaps the text for the editor
 * in place (the keyboard goes into it, and comes back to Edit when the edit ends), and Delete, which asks for a second press. The buttons show on hover and
 * while the keyboard is on one of them.
 */
export function Comment({ comment, author, isOwn, onEdit, onDelete }: CommentProps) {
    const [isEditing, setIsEditing] = useState(false);
    const editButton = useRef<HTMLButtonElement>(null);
    const wasEditing = useRef(false);

    // The editor that held the keyboard is gone with the edit, and the page has it: it goes back to the button that opened the editor, unless the person has moved on.
    useEffect(() => {
        const isLost = !document.activeElement || document.activeElement === document.body;

        if (wasEditing.current && !isEditing && isLost) editButton.current?.focus();

        wasEditing.current = isEditing;
    }, [isEditing]);

    return (
        <article className={ styles.comment } data-comment-id={ comment.id }>
            <header className={ styles.head }>
                <span className={ styles.author }>{ author }</span>
                <time className={ styles.time } dateTime={ new Date(comment.createdAt).toISOString() } title={ formatFullTime(comment.createdAt) }>
                    { formatMessageTime(comment.createdAt) }
                </time>
                { comment.editedAt !== undefined && <span className={ styles.time } title={ `Edited ${ formatFullTime(comment.editedAt) }` }>edited</span> }

                { isOwn && !isEditing && (
                    <span className={ styles.actions }>
                        <Button ref={ editButton } size="xs" variant="filling" aria-label="Edit comment" onPress={ () => setIsEditing(true) }>Edit</Button>
                        <ConfirmButton size="xs" variant="filling" color="danger" confirmColor="danger" confirmVariant="filled" onConfirm={ onDelete }>Delete</ConfirmButton>
                    </span>
                ) }
            </header>

            { isEditing
                ? (
                    <CommentEditor
                        initial={ comment.body }
                        aria-label="Edit comment"
                        submitLabel="Save"
                        autoFocus
                        onCancel={ () => setIsEditing(false) }
                        onSubmit={ async (body) => {
                            // Nothing changed: the daemon would still mark the comment edited.
                            const isTaken = body === comment.body.trim() || await onEdit(body);

                            if (isTaken) setIsEditing(false);

                            return isTaken;
                        } }
                    />
                )
                : <Markdown text={ comment.body } fromPerson={ comment.author.kind === 'user' } /> }
        </article>
    );
}
