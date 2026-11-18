import { Button } from '@clowdy/components/Button';
import { CopyButton } from '@clowdy/components/CopyButton';
import { Spinner } from '@clowdy/components/Spinner';
import { Badge } from '@clowdy/components/Tag';
import { Text } from '@clowdy/components/Text';
import { ArrowUpRight, Check } from '@clowdy/icons/14';

import styles from './AccountRow.module.css';
import { accountLine, isSignInRunning } from './providerView';

import type { AgentInfo } from '@clowdy/protocol';
import type { useAgentCommands } from './useAgentCommands';

export interface AccountRowProps {
    agent: AgentInfo;
    commands: ReturnType<typeof useAgentCommands>;
}

/** What the vendor's program printed for the person: a sign-in link to copy into another browser or open here, and a code to enter on the page. */
function SignInLink({ url, code }: { url?: string; code?: string }) {
    return (
        <div className={ styles.link }>
            { url && (
                <>
                    <Text variant="xs" color="secondary" className={ styles.url } truncate title={ url }>{ url }</Text>
                    <CopyButton value={ url } variant="bordered" size="xs">Copy link</CopyButton>
                    <Button variant="bordered" size="xs" href={ url } target="_blank" rel="noreferrer">
                        <ArrowUpRight aria-hidden />
                        Open
                    </Button>
                </>
            ) }
            { code && (
                <div className={ styles.code }>
                    <Text variant="xs" color="secondary">Enter this code on the page</Text>
                    <CopyButton value={ code } variant="filling" size="xs" tooltip="Copy the code">{ code }</CopyButton>
                </div>
            ) }
        </div>
    );
}

/**
 * Who is signed in to the agent, and the button that signs in (or in again). While the daemon runs the vendor's login the
 * row follows it: the link the program printed, with Copy and Open, and Cancel; after it, what went wrong, if anything.
 */
export function AccountRow({ agent, commands }: AccountRowProps) {
    const line = accountLine(agent);
    const session = agent.signInSession;
    const running = isSignInRunning(session);
    const signedIn = agent.signIn?.status === 'signed-in';
    // A program that is missing, or a provider that is off, has nobody to sign in.
    const canAct = agent.status === 'ready' && agent.enabled;

    return (
        <div className={ styles.account }>
            <div className={ styles.line }>
                <div className={ styles.who }>
                    <Text variant="sm" color={ line.tone === 'default' ? undefined : line.tone === 'muted' ? 'secondary' : line.tone } truncate title={ line.text }>{ line.text }</Text>
                    { line.plan && <Badge size="xs" color="secondary" textValue={ line.plan }>{ line.plan }</Badge> }
                </div>

                { canAct && !running && (
                    agent.canSignIn
                        ? (
                            <Button
                                variant={ signedIn ? 'bordered' : 'filled' }
                                color={ signedIn ? 'secondary' : 'primary' }
                                size="sm"
                                isPending={ commands.pending.has('signIn') }
                                onPress={ () => void commands.signIn() }
                            >
                                { signedIn ? 'Sign in again' : 'Sign in' }
                            </Button>
                        )
                        : agent.login && <Text variant="xs" color="secondary">{ `Run \`${ agent.login }\` in a terminal` }</Text>
                ) }
            </div>

            { line.detail && <Text variant="xs" color="secondary">{ line.detail }</Text> }

            { running && (
                <div className={ styles.session } role="status">
                    <div className={ styles.progress }>
                        <Spinner size="sm" />
                        <Text variant="sm" className={ styles.step }>{ session.step === 'starting' ? 'Starting the sign-in…' : 'Finish signing in in your browser. This page updates when it is done.' }</Text>
                        <Button variant="inline" color="secondary" size="sm" isPending={ commands.pending.has('cancelSignIn') } onPress={ () => void commands.cancelSignIn() }>Cancel</Button>
                    </div>
                    { (session.url || session.code) && <SignInLink url={ session.url } code={ session.code } /> }
                </div>
            ) }

            { !running && session?.step === 'failed' && <Text variant="sm" color="danger" role="alert">{ session.message ?? 'The sign-in failed.' }</Text> }
            { !running && session?.step === 'cancelled' && <Text variant="sm" color="secondary">{ session.message ?? 'The sign-in was cancelled.' }</Text> }
            { !running && session?.step === 'done' && (
                <Text variant="sm" color="success" className={ styles.done }>
                    <Check aria-hidden />
                    Signed in
                </Text>
            ) }
        </div>
    );
}
