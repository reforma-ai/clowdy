export function distanceBetween(a: [number, number], b: [number, number]): number {
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function evaluateValue<T>(v: T | (() => T)): T {
    return typeof v === 'function' ? (v as () => T)() : v;
}

export function disableFocusByTab(area: HTMLElement | HTMLElement[] | NodeListOf<HTMLElement>) {
    const elements = Array.isArray(area) ? area : (area instanceof NodeList ? Array.from(area) : [area]);

    if (!elements.length) {
        return;
    }

    elements.forEach((element) => {
        if (!element) {
            return;
        }

        element.setAttribute('data-tab-disabled', 'true');
        const focusableElements = element.querySelectorAll('input:not([tabindex="-1"]), textarea:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])');

        focusableElements.forEach((el) => {
            (el as HTMLElement).setAttribute('tabindex', '-1');
            (el as HTMLElement).setAttribute('data-tab-disabled', 'true');
        });
    });
}

export function enableFocusByTab(area: HTMLElement | HTMLElement[] | NodeListOf<HTMLElement>) {
    const elements = Array.isArray(area) ? area : (area instanceof NodeList ? Array.from(area) : [area]);

    if (!elements.length) {
        return;
    }

    elements.forEach((element) => {
        if (!element) {
            return;
        }

        element.removeAttribute('data-tab-disabled');
        const disabledByTabElements = element.querySelectorAll('[data-tab-disabled][tabindex]');

        disabledByTabElements.forEach((el) => {
            (el as HTMLElement).setAttribute('tabindex', '0');
            (el as HTMLElement).removeAttribute('data-tab-disabled');
        });
    });
}
