import { Button } from '@clowdy/components/Button';
import { Loader } from '@clowdy/components/Loader';
import { Text } from '@clowdy/components/Text';
import { useLayoutEffect, useRef, useState } from 'react';

import { useProjectState, useProjectUi, useRootStore } from '../../stores';
import { StreamLinksContext, type StreamLinks } from '../../stream/StreamLinks';
import { sendCommand } from './commands';
import { Comment } from './Comment';
import { CommentEditor } from './CommentEditor';
import styles from './CommentsSection.module.css';
import { None, Section } from './DetailSections';
import { createdCommentId } from './taskView';
import { MAX_COMMENTS, useTaskComments } from './useTaskComments';

import type { Actor, TaskComment, TaskId } from '@clowdy/protocol';

export interface CommentsSectionProps {
    taskId: TaskId;
    /** Opens the run an agent's comment names, in Agents. */
    onOpenRun: (runId: string) => void;
    /** Opens a task a comment names by its key. */
    onOpenTask: (taskId: TaskId) => void;
    /** The task is archived: its comments are read and nothing more, with no composer and no Edit or Delete on the person's own. */
    isReadOnly?: boolean;
}

/**
 * The task's comments, oldest first, with a composer under them. They are read when the panel opens and again when anyone changes them (`useTaskComments`);
 * a read that fails leaves the comments on show and says so under them, with Retry. The list does not move when a comment arrives, since it grows at its end;
 * the person's own comment brings the composer back into view once it is in the list, and nothing else scrolls. The person edits and deletes their own comments,
 * and an agent's are read only; those of an archived task are all read only. What the person has typed in the composer and not sent is kept for the task
 * (`ProjectUi.commentDraft`), so it is there when the task's panel opens again.
 */
export function CommentsSection({ taskId, onOpenRun, onOpenTask, isReadOnly = false }: CommentsSectionProps) {
    const root = useRootStore();
    const project = useProjectState();
    const ui = useProjectUi();
    const { state, retry } = useTaskComments(taskId);
    const composer = useRef<HTMLDivElement>(null);
    // The comment the person has just sent, which the composer is brought into view for once it is in the list, and the one it was done for.
    const [sentId, setSentId] = useState<string>();
    const broughtIntoView = useRef<string>(undefined);
    // A key in a comment is a chip that opens the task, as in a chat, an archived one the window knows too. One object for the section's life, which reads the latest project and handler when asked.
    const latest = useRef({ project, onOpenTask });
    const [links] = useState<StreamLinks>(() => ({
        taskOfKey: key => latest.current.project.taskOfKey(key),
        onOpenTask: id => latest.current.onOpenTask(id),
    }));

    useLayoutEffect(() => {
        latest.current = { project, onOpenTask };
    });

    // The daemon's reply and the list that holds the comment come in either order, so the effect looks again when either arrives.
    useLayoutEffect(() => {
        if (sentId !== undefined && sentId !== broughtIntoView.current && state.status === 'ready' && state.comments.some(comment => comment.id === sentId)) {
            broughtIntoView.current = sentId;
            composer.current?.scrollIntoView({ block: 'nearest' });
        }
    }, [state, sentId]);

    const authorOf = (author: Actor) => {
        if (author.kind === 'user') return 'You';

        if (author.kind === 'provider') return author.provider;

        const run = project.runs.get(author.runId);

        // The run may have been deleted since: the comment stays, and the name is only "Agent".
        return run
            ? <button type="button" className={ styles.agent } title={ run.summary || run.name } onClick={ () => onOpenRun(run.id) }>{ run.name }</button>
            : 'Agent';
    };

    const send = async (body: string) => {
        const result = await sendCommand(root, { type: 'task.comment.add', taskId, body });

        if (result.ok) setSentId(createdCommentId(result.data));

        return result.ok;
    };

    const edit = async (comment: TaskComment, body: string) => (await sendCommand(root, { type: 'task.comment.edit', taskId, commentId: comment.id, body })).ok;

    const remove = async (comment: TaskComment) => void await sendCommand(root, { type: 'task.comment.delete', taskId, commentId: comment.id });

    return (
        <Section title="Comments" count={ state.status === 'ready' ? state.total : undefined }>
            { state.status === 'loading' && (
                <div className={ styles.loading }>
                    <Loader size="xs" />
                    <Text color="secondary">Loading comments…</Text>
                </div>
            ) }

            { state.status === 'failed' && (
                <div className={ styles.failed }>
                    <None>Comments did not load</None>
                    <Button size="xs" variant="bordered" onPress={ retry }>Retry</Button>
                </div>
            ) }

            { state.status === 'ready' && state.comments.length === 0 && <None>No comments yet</None> }

            { state.status === 'ready' && state.comments.length > 0 && (
                <StreamLinksContext value={ links }>
                    <div className={ styles.list }>
                        { state.comments.map(comment => (
                            <Comment
                                key={ comment.id }
                                comment={ comment }
                                author={ authorOf(comment.author) }
                                isOwn={ !isReadOnly && comment.author.kind === 'user' }
                                onEdit={ body => edit(comment, body) }
                                onDelete={ () => remove(comment) }
                            />
                        )) }
                    </div>
                </StreamLinksContext>
            ) }

            { state.status === 'ready' && state.isCut && <None>{ `Showing the first ${ MAX_COMMENTS } comments` }</None> }

            { state.status === 'ready' && state.refreshError !== undefined && (
                <div className={ styles.failed } role="alert">
                    <None>Comments did not refresh</None>
                    <Button size="xs" variant="bordered" onPress={ retry }>Retry</Button>
                </div>
            ) }

            { !isReadOnly && (
                <div ref={ composer }>
                    <CommentEditor
                        key={ taskId }
                        aria-label="Write a comment"
                        submitLabel="Send"
                        draft={ ui.commentDraft(taskId) }
                        onDraftChange={ text => ui.setCommentDraft(taskId, text) }
                        onSubmit={ send }
                    />
                </div>
            ) }
        </Section>
    );
}
