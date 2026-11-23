import { convertToMilliseconds } from './date';

class LocalStorageService {
    #subscribers: Map<string, Set<(value: any) => void>> = new Map();

    constructor() {
        window.addEventListener('storage', this.#handleStorageEvent.bind(this));
    }

    /**
     * Get value from localStorage or sessionStorage
     */
    get<T = any>(key: string): T | null {
        let rawData: string | null = this.#get(key, sessionStorage) ?? this.#get(key, localStorage);

        if (rawData === null) {
            return null;
        }

        let data: string | { expire: number; value: T };

        try {
            data = JSON.parse(rawData);
        } catch (err) {
            // It's not JSON, treat as plain string
            data = rawData;
        }

        try {
            if (data && typeof data === 'object' && 'expire' in data && 'value' in data) {
                return data.expire > Date.now() ? data.value : null;
            }

            return data as T;
        } catch (err) {
            return null;
        }
    }

    /**
     * Set value to localStorage or sessionStorage with optional expiration
     */
    set<T = any>(key: string, value: T, expire?: number | 'session' | `${number}${'d' | 'h' | 'm'}`) {
        this.remove(key);

        // Set to session storage
        if (expire === 'session') {
            this.#set(key, typeof value === 'object' ? JSON.stringify(value) : String(value), sessionStorage);

            return;
        }

        // Convert expire from string (7d, 5m, 30s) to milliseconds
        if (typeof expire === 'string') {
            expire = convertToMilliseconds(expire);
        }

        // Set to local storage with expire flag
        if (expire && typeof expire == 'number') {
            this.#set(
                key,
                JSON.stringify({
                    value,
                    expire: Date.now() + expire,
                })
            );
        } else {
            this.#set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        }

        this.#notifySubscribers(key);
    }

    /**
     * Remove value from both localStorage and sessionStorage
     */
    remove(key: string) {
        this.#remove(key, sessionStorage);
        this.#remove(key, localStorage);
    }

    /**
     * Subscribe to changes for a specific key
     */
    subscribe(key: string, callback: (value: any) => void, callOnInit = false) {
        if (!this.#subscribers.has(key)) {
            this.#subscribers.set(key, new Set());
        }

        const callbacks = this.#subscribers.get(key);

        callbacks?.add(callback);

        if (callOnInit) {
            callback(this.get(key));
        }

        // Return disposer function
        return () => {
            callbacks?.delete(callback);

            if (callbacks?.size === 0) {
                this.#subscribers.delete(key);
            }
        };
    }

    #get(key: string, from = localStorage) {
        return from.getItem(key);
    }

    #set(key: string, value: string, to = localStorage) {
        to.setItem(key, value);
    }

    #remove(key: string, from = localStorage) {
        from.removeItem(key);
    }

    // Notify all subscribers of a key change
    #notifySubscribers(key: string) {
        const callbacks = this.#subscribers.get(key);

        if (callbacks) {
            callbacks.forEach(callback => {
                callback(this.get(key));
            });
        }
    }

    // Storage event if fired when a key is changed in another tab
    #handleStorageEvent(event: StorageEvent) {
        if (event.key) {
            this.#notifySubscribers(event.key);
        }
    }
}

export const localStorageService = new LocalStorageService();
