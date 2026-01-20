/**
 * Unit tests for favicon.js
 * @jest-environment jsdom
 */

'use strict';

const Favicon = require('../favicon.js');

describe('Favicon module', () => {
    let originalIsFirefox;

    beforeEach(() => {
        originalIsFirefox = Favicon.isFirefox;
        localStorage.clear();
    });

    afterEach(() => {
        Favicon.isFirefox = originalIsFirefox;
    });

    describe('getProviderList', () => {
        it('returns all available providers', () => {
            const providers = Favicon.getProviderList();
            expect(providers).toHaveLength(3);
            expect(providers.map(p => p.key)).toEqual(['duckduckgo', 'google', 'yandex']);
            expect(providers.map(p => p.name)).toEqual(['DuckDuckGo', 'Google', 'Yandex']);
        });
    });

    describe('getProvider', () => {
        it('returns default provider when nothing is stored', () => {
            expect(Favicon.getProvider()).toBe('duckduckgo');
        });

        it('returns stored provider when valid', () => {
            localStorage.setItem('options.favicon_provider', 'google');
            expect(Favicon.getProvider()).toBe('google');
        });

        it('returns default when stored provider is invalid', () => {
            localStorage.setItem('options.favicon_provider', 'invalid_provider');
            expect(Favicon.getProvider()).toBe('duckduckgo');
        });
    });

    describe('getUrl (Chrome mode)', () => {
        beforeEach(() => {
            Favicon.isFirefox = false;
        });

        it('returns Chrome favicon API URL', () => {
            const url = Favicon.getUrl('https://example.com/page');
            expect(url).toBe('/_favicon/?pageUrl=https%3A%2F%2Fexample.com%2Fpage&size=16');
        });

        it('encodes special characters in URL', () => {
            const url = Favicon.getUrl('https://example.com/path?query=value&other=123');
            expect(url).toContain('pageUrl=');
            expect(url).toContain(encodeURIComponent('https://example.com/path?query=value&other=123'));
        });
    });

    describe('getUrl (Firefox mode)', () => {
        beforeEach(() => {
            Favicon.isFirefox = true;
        });

        it('uses DuckDuckGo by default', () => {
            const url = Favicon.getUrl('https://example.com/page');
            expect(url).toBe('https://icons.duckduckgo.com/ip3/example.com.ico');
        });

        it('uses Google when selected', () => {
            localStorage.setItem('options.favicon_provider', 'google');
            const url = Favicon.getUrl('https://example.com/page');
            expect(url).toBe('https://www.google.com/s2/favicons?sz=32&domain=example.com');
        });

        it('uses Yandex when selected', () => {
            localStorage.setItem('options.favicon_provider', 'yandex');
            const url = Favicon.getUrl('https://example.com/page');
            expect(url).toBe('https://favicon.yandex.net/favicon/example.com');
        });

        it('extracts hostname correctly from complex URLs', () => {
            const url = Favicon.getUrl('https://subdomain.example.com:8080/path?query=1#hash');
            expect(url).toBe('https://icons.duckduckgo.com/ip3/subdomain.example.com.ico');
        });

        it('returns empty string for invalid URLs', () => {
            const url = Favicon.getUrl('not-a-valid-url');
            expect(url).toBe('');
        });

        it('returns empty string for empty input', () => {
            const url = Favicon.getUrl('');
            expect(url).toBe('');
        });
    });
});

