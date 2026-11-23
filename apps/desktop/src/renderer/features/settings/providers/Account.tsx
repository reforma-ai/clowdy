import { Button } from '@clowdy/components/Button';
import { CopyButton, copyWithFeedback, useCopyFeedback } from '@clowdy/components/CopyButton';
import { Badge } from '@clowdy/components/Tag';
import { Text } from '@clowdy/components/Text';
import { ArrowUpRight } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import styles from './Account.module.css';
import { InlineCode } from './InlineCode';
import { accountLine, isSignInRunning } from './providerView';

import type { AgentInfo } from '@clowdy/protocol';
import type { useAgentCommands } from './useAgentCommands';

const TONE_COLOR = { default: undefined, muted: 'secondary', warning: 'warning' } as const;

export interface AccountProps {
    agent: AgentInfo;
    commands: ReturnType<typeof useAgentCommands>;
}

/** The link the vendor's program printed, copied for another browser. The label says when it is done. */
function CopyLinkButton({ url }: { url: string }) {
    const { copied, markCopied } = useCopyFeedback();

    return (
        <Button variant="inline" color="primary" onPress={() => copyWithFeedback(url, markCopied)}>
            {copied ? 'Copied' : 'Copy link'}
        </Button>
    );
}

/**
 * A sign-in the daemon runs, as a plate under the card's first row: where to finish it and what happens then, a one-time code when the
 * program printed one, then a link and a button. The link opens the page again (`https:` only: the app opens nothing else) or, for another
 * kind of link, copies it; the button cancels. Nothing when no sign-in runs.
 */
export function SignInPanel({ agent, commands, className }: AccountProps & { className?: string }) {
    const session = agent.signInSession;

    if (!isSignInRunning(session)) return null;

    const { url, code } = session;
    const starting = session.step === 'starting';

    return (
        <div className={cn(styles.panel, className)}>
            <div className={styles.panelText} role="status">
                <Text variant="sm" weight="medium">
                    {starting ? 'Starting the sign-in…' : 'Continue in your browser'}
                </Text>
                {!starting && (
                    <Text variant="sm" color="secondary">
                        {"Once you sign in, you'll be connected automatically"}
                    </Text>
                )}
                {code && (
                    <div className={styles.code}>
                        <Text variant="sm" color="secondary">
                            Enter this code on the page
                        </Text>
                        <CopyButton value={code} variant="filling" size="xs" tooltip="Copy the code">
                            {code}
                        </CopyButton>
                    </div>
                )}
            </div>
            <div className={styles.panelActions}>
                {url &&
                    (url.startsWith('https://') ? (
                        <Button variant="inline" color="primary" href={url} target="_blank" rel="noreferrer">
                            <ArrowUpRight aria-hidden />
                            Reopen browser
                        </Button>
                    ) : (
                        <CopyLinkButton url={url} />
                    ))}
                <Button
                    variant="bordered"
                    size="sm"
                    isPending={commands.pending.has('cancelSignIn')}
                    onPress={() => void commands.cancelSignIn()}
                >
                    Cancel
                </Button>
            </div>
        </div>
    );
}

/** Who is signed in to the agent and the plan, or why there is nobody, with the daemon's note on that; a sign-in that failed says why under it. */
export function AccountLine({ agent }: { agent: AgentInfo }) {
    const session = agent.signInSession;
    const line = accountLine(agent);

    return (
        <>
            <div className={styles.who}>
                <Text variant="sm" color={TONE_COLOR[line.tone]} truncate title={line.text}>
                    {line.text}
                </Text>
                {line.plan && (
                    <Badge size="xs" color="secondary" textValue={line.plan} className={styles.plan}>
                        {line.plan}
                    </Badge>
                )}
            </div>
            {line.detail && (
                <Text variant="xs" color="secondary">
                    <InlineCode text={line.detail} />
                </Text>
            )}
            {session?.step === 'failed' && (
                <Text variant="sm" color="danger" role="alert">
                    {session.message ?? 'Sign-in failed'}
                </Text>
            )}
        </>
    );
}

/**
 * The button at the end of the card's first row: Sign in (or Sign in again), or the vendor's command when the daemon cannot run the
 * sign-in. Nothing while a sign-in runs (its plate has Cancel), and nothing for a program that is missing or a provider that is off,
 * which have nobody to sign in.
 */
export function SignInAction({ agent, commands }: AccountProps) {
    const signedIn = agent.signIn?.status === 'signed-in';

    if (agent.status !== 'ready' || !agent.enabled || isSignInRunning(agent.signInSession)) return null;

    if (!agent.canSignIn) {
        return agent.login ? (
            <Text variant="xs" color="secondary">
                Run{' '}
                <Text as="code" variant="code">
                    {agent.login}
                </Text>{' '}
                in a terminal
            </Text>
        ) : null;
    }

    return (
        <Button
            variant={signedIn ? 'bordered' : 'filled'}
            color={signedIn ? 'secondary' : 'primary'}
            size="sm"
            isPending={commands.pending.has('signIn')}
            onPress={() => void commands.signIn()}
        >
            {signedIn ? 'Sign in again' : 'Sign in'}
        </Button>
    );
}
