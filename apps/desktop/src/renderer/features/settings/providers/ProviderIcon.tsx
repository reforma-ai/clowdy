import type { SVGProps } from 'react';

const RAYS = Array.from({ length: 12 }, (_, index) => index);

/** Claude's mark: a burst of twelve rays. */
function ClaudeMark() {
    return (
        <g stroke="#d97757" strokeWidth="2.3" strokeLinecap="round">
            { RAYS.map((index) => {
                const angle = (index * 30 * Math.PI) / 180;
                const outer = index % 2 === 0 ? 10 : 8;
                const x = Math.sin(angle);
                const y = -Math.cos(angle);

                return <line key={ index } x1={ 12 + x * 3.2 } y1={ 12 + y * 3.2 } x2={ 12 + x * outer } y2={ 12 + y * outer } />;
            }) }
        </g>
    );
}

/** Codex's mark: three loops that cross, in the manner of OpenAI's knot. */
function CodexMark() {
    return (
        <g fill="none" stroke="currentColor" strokeWidth="1.7">
            { [0, 60, 120].map(angle => <rect key={ angle } x="7.2" y="2.6" width="9.6" height="18.8" rx="4.8" transform={ `rotate(${ angle } 12 12)` } />) }
        </g>
    );
}

/** Cursor's mark: a cube seen from a corner. */
function CursorMark() {
    return (
        <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round">
            <path d="M12 2.6l8.2 4.7v9.4L12 21.4l-8.2-4.7V7.3z" />
            <path d="M3.8 7.3L12 12l8.2-4.7M12 12v9.4" />
        </g>
    );
}

const MARKS: Record<string, () => React.JSX.Element> = { claude: ClaudeMark, codex: CodexMark, cursor: CursorMark };

export interface ProviderIconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
    /** The agent's id; an agent without a mark of its own gets a plain ring. */
    agentId: string;
    size?: number;
}

/** A provider's mark, drawn small and in its own colour (Claude) or the text colour. */
export function ProviderIcon({ agentId, size = 20, ...props }: ProviderIconProps) {
    const Mark = MARKS[agentId];

    return (
        <svg width={ size } height={ size } viewBox="0 0 24 24" aria-hidden focusable="false" { ...props }>
            { Mark ? <Mark /> : <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.7" /> }
        </svg>
    );
}
