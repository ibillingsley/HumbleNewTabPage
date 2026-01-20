'use strict';

/**
 * Favicon provider module for Firefox compatibility.
 * Chrome uses the built-in /_favicon/ API, but Firefox doesn't support it.
 * This module provides external favicon services for Firefox.
 */

const Favicon = {
    // Detect Firefox (no chrome.favicon API and has browser.runtime)
    isFirefox: typeof chrome !== 'undefined' && 
               typeof chrome.runtime !== 'undefined' &&
               !chrome.runtime.getURL('').startsWith('chrome-extension://'),

    // Available providers with URL templates
    // {domain} is replaced with the hostname
    providers: {
        duckduckgo: {
            name: 'DuckDuckGo',
            url: 'https://icons.duckduckgo.com/ip3/{domain}.ico'
        },
        google: {
            name: 'Google',
            url: 'https://www.google.com/s2/favicons?sz=32&domain={domain}'
        },
        yandex: {
            name: 'Yandex',
            url: 'https://favicon.yandex.net/favicon/{domain}'
        }
    },

    // Default provider
    defaultProvider: 'duckduckgo',

    /**
     * Get the current provider key from config or default
     * @returns {string} Provider key
     */
    getProvider() {
        const stored = localStorage.getItem('options.favicon_provider');
        return (stored && this.providers[stored]) ? stored : this.defaultProvider;
    },

    /**
     * Get favicon URL for a given page URL
     * @param {string} pageUrl - The full URL of the page
     * @returns {string} Favicon URL
     */
    getUrl(pageUrl) {
        // Chrome: use built-in favicon API
        if (!this.isFirefox) {
            return `/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=16`;
        }

        // Firefox: use external provider
        try {
            const domain = new URL(pageUrl).hostname;
            const provider = this.providers[this.getProvider()];
            return provider.url.replace('{domain}', domain);
        } catch {
            // Invalid URL, return empty
            return '';
        }
    },

    /**
     * Get list of providers for options dropdown
     * @returns {Array<{key: string, name: string}>}
     */
    getProviderList() {
        return Object.entries(this.providers).map(([key, val]) => ({
            key,
            name: val.name
        }));
    }
};

// Export for both browser and Node.js (testing)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Favicon;
}

