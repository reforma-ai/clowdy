import styles from './ThemePreview.module.css';

/**
 * A miniature of the app window in one theme, drawn from the design tokens: `data-theme` re-scopes them for this
 * subtree, so the picture follows the real colors and shows either theme whichever one the app is in.
 */
export function ThemePreview({ theme }: { theme: 'light' | 'dark' }) {
    return (
        <div className={ styles.preview } data-theme={ theme } aria-hidden>
            <span className={ styles.project } />
            <span className={ styles.rail }>
                <i data-active />
                <i />
                <i />
                <i />
            </span>
            <div className={ styles.plate }>
                <div className={ styles.list }>
                    <i data-active />
                    <i />
                    <i />
                </div>
                <div className={ styles.main }>
                    <b />
                    <i />
                    <i />
                    <span className={ styles.button } />
                </div>
            </div>
        </div>
    );
}
