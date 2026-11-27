/** The texts that name `element`: those its `aria-labelledby` points at, in order, else its `aria-label`. */
function labelsOf(element: Element): string[] {
    const ids = element.getAttribute('aria-labelledby');

    if (!ids) return [element.getAttribute('aria-label') ?? ''];

    return ids.split(/\s+/).map(id => element.ownerDocument.getElementById(id)?.textContent?.trim() ?? '');
}

/** The accessible name of `element` as the tests read it: the text its `aria-labelledby` points at, else its `aria-label`. */
export function nameOf(element: Element): string | null {
    const name = labelsOf(element).filter(Boolean).join(' ');

    return name || null;
}

/**
 * The first element under `within` that matches `selector` and is named `name`, or `null`, as `querySelector` answers. One of its labels is
 * enough: a select's button is labelled by its value and by the title of its row.
 */
export function named<T extends Element = HTMLElement>(within: ParentNode, selector: string, name: string): T | null {
    return (
        [...within.querySelectorAll<T>(selector)].find(
            element => nameOf(element) === name || labelsOf(element).includes(name)
        ) ?? null
    );
}
