/**
 * A card's question is a title, then paragraphs after blank lines: the facts and the "My pick: ..." line
 * (the card protocol of clowdy:semi-manual). A question without blank lines is all title.
 */
export function splitQuestion(text: string): { title: string; paragraphs: string[] } {
    const [title = '', ...paragraphs] = text.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);

    return { title, paragraphs };
}
