import { useEffect, useRef } from 'react';

/** Open a destination only after a file has stayed over it, without taking the drop. */
export function useFileDragHover(targetOf: (element: Element) => string | undefined, open: (key: string) => void) {
    const latest = useRef({ targetOf, open });
    latest.current = { targetOf, open };

    useEffect(() => {
        let target: string | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const clear = () => {
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
            target = undefined;
        };
        const over = (event: DragEvent) => {
            const next =
                event.dataTransfer?.types.includes('Files') && event.target instanceof Element
                    ? latest.current.targetOf(event.target)
                    : undefined;
            if (next === target) return;
            clear();
            if (next === undefined) return;
            target = next;
            timer = setTimeout(() => {
                timer = undefined;
                latest.current.open(next);
            }, 1000);
        };
        const leave = (event: DragEvent) => {
            if (
                !event.relatedTarget &&
                (event.target === document ||
                    event.target === document.documentElement ||
                    event.clientX <= 0 ||
                    event.clientY <= 0 ||
                    event.clientX >= window.innerWidth ||
                    event.clientY >= window.innerHeight)
            )
                clear();
        };
        document.addEventListener('dragover', over, true);
        document.addEventListener('dragleave', leave, true);
        document.addEventListener('dragend', clear, true);
        document.addEventListener('drop', clear, true);
        return () => {
            clear();
            document.removeEventListener('dragover', over, true);
            document.removeEventListener('dragleave', leave, true);
            document.removeEventListener('dragend', clear, true);
            document.removeEventListener('drop', clear, true);
        };
    }, []);
}
