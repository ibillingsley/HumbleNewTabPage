/**
 * Unit tests for newtab.js bookmark loading optimization
 * Run with: npm test
 * @jest-environment jsdom
 * @jest-environment-options {"url": "http://localhost/newtab.html"}
 */

'use strict';

// Polyfill structuredClone for Node.js test environment
if (typeof structuredClone === 'undefined') {
    global.structuredClone = (obj) => JSON.parse(JSON.stringify(obj));
}

// Mock IndexedDB using fake-indexeddb
require('fake-indexeddb/auto');

// Use @webext-core/fake-browser for supported Chrome APIs
const { fakeBrowser } = require('@webext-core/fake-browser');

// Load themes (shared between prevent-white-flash.js and newtab.js)
const themesModule = require('../themes.js');
global.themes = themesModule || global.themes;

// Use the REAL BookmarkCache implementation (with fake-indexeddb)
const BookmarkCache = require('../bookmark-cache.js');
global.BookmarkCache = BookmarkCache;

// Load Favicon module
const Favicon = require('../favicon.js');
global.Favicon = Favicon;

// Test bookmark data - this will be loaded into the real BookmarkCache
const testBookmarkTree = [{
    id: '0',
    title: '',
    children: [
        {
            id: '1',
            title: 'Bookmarks Bar',
            children: [
                { id: '10', title: 'Folder A', children: [
                    { id: '100', title: 'Nested 1', url: 'https://nested1.com' },
                    { id: '101', title: 'Nested 2', url: 'https://nested2.com' },
                    { id: '102', title: 'Nested Folder C', children: [
                        { id: '1000', title: 'Deep 1', url: 'https://deep1.com' },
                        { id: '1001', title: 'Deep 2', url: 'https://deep2.com' }
                    ]}
                ]},
                { id: '11', title: 'Site 1', url: 'https://example.com' },
                { id: '12', title: 'Folder B', children: [] }
            ]
        },
        {
            id: '2',
            title: 'Other Bookmarks',
            children: [
                { id: '20', title: 'Site 2', url: 'https://test.com' },
                { id: '21', title: 'Site 3', url: 'https://demo.com' }
            ]
        }
    ]
}];

// Top sites test data
const testTopSites = [
    { title: 'Google', url: 'https://google.com' },
    { title: 'GitHub', url: 'https://github.com' }
];

// Recently closed test data
const testRecentlyClosed = [];

// Devices test data
const testDevices = [];

function setupDOM() {
    document.body.innerHTML = `
    <div id="main"></div>
    <div id="menu"></div>
    <div id="options" style="display:none">
        <a id="options_button"></a>
        <a id="options_close_button"></a>
        <ul id="options_nav"></ul>
        <div id="options_show_bookmarks"></div>
        <input id="options_font" />
        <select id="options_theme"></select>
        <textarea id="options_export"></textarea>
        <textarea id="options_import"></textarea>
        <textarea id="all_css"></textarea>
    </div>`;
}

function setupGlobals() {
    // Start with fakeBrowser for supported APIs (tabs, storage, runtime, etc.)
    // Then add custom implementations for unsupported APIs
    global.chrome = {
        // Use fakeBrowser's implementations where available
        tabs: fakeBrowser.tabs,
        storage: fakeBrowser.storage,
        runtime: fakeBrowser.runtime,

        // Custom implementations for APIs not in fakeBrowser
        bookmarks: {
            getTree: () => Promise.resolve(testBookmarkTree),
            getChildren: (id) => {
                // Find folder in tree and return its children
                const findFolder = (nodes, targetId) => {
                    for (const node of nodes) {
                        if (node.id === targetId) return node;
                        if (node.children) {
                            const found = findFolder(node.children, targetId);
                            if (found) return found;
                        }
                    }
                    return null;
                };
                const folder = findFolder(testBookmarkTree, id);
                return Promise.resolve(folder?.children || []);
            },
            get: (ids) => {
                const findNode = (nodes, targetId) => {
                    for (const node of nodes) {
                        if (node.id === targetId) return node;
                        if (node.children) {
                            const found = findNode(node.children, targetId);
                            if (found) return found;
                        }
                    }
                    return null;
                };
                const results = ids.map(id => findNode(testBookmarkTree, id)).filter(Boolean);
                return Promise.resolve(results);
            },
            getRecent: (count) => Promise.resolve([])
        },
        sessions: {
            getRecentlyClosed: () => Promise.resolve(testRecentlyClosed),
            getDevices: () => Promise.resolve(testDevices),
            restore: (sessionId) => Promise.resolve(),
            onChanged: { addListener: () => {}, removeListener: () => {} }
        },
        topSites: {
            get: () => Promise.resolve(testTopSites)
        }
        // Note: fontSettings is optional and only used in options panel
    };
}

/**
 * Populate the real BookmarkCache with test data
 */
async function populateBookmarkCache() {
    await BookmarkCache.openDB();
    await BookmarkCache.clear();

    // Use the real flattenTree and replaceAll methods
    const records = BookmarkCache.flattenTree(testBookmarkTree);

    // Add metadata (must match format used by fullSync)
    const now = Date.now();
    records.push({ key: 'meta:version', value: { value: BookmarkCache.CACHE_VERSION } });
    records.push({ key: 'meta:lastSync', value: { value: now } });

    await BookmarkCache.replaceAll(records);

    // Load into memory cache for fast reads
    await BookmarkCache.loadAllData(true);
}

describe('newtab.js', () => {
    beforeEach(async () => {
        // Reset fake-browser state
        fakeBrowser.reset();

        setupDOM();
        setupGlobals();
        localStorage.clear();

        // Reset the real BookmarkCache and populate with test data
        BookmarkCache.close();
        BookmarkCache._db = null;
        BookmarkCache._allDataCache = null;
        await populateBookmarkCache();

        // Clear newtab.js module cache so it reloads fresh
        delete require.cache[require.resolve('../newtab.js')];
    });

    afterEach(() => {
        BookmarkCache.close();
    });

    describe('getColumnIds', () => {
        test('returns correct column IDs from localStorage', () => {
            localStorage.setItem('column.0.0', '1');
            localStorage.setItem('column.0.1', '2');
            localStorage.setItem('column.1.0', 'top');

            const { getColumnIds } = require('../newtab.js');
            const columnIds = getColumnIds();

            expect(columnIds).toHaveLength(3);
            expect(columnIds).toEqual(['1', '2', 'top']);
        });
    });

    describe('getChildren_internal', () => {
        // These tests now use the REAL BookmarkCache with fake-indexeddb!
        test('fetches children from cache on demand', async () => {
            const { getChildren_internal } = require('../newtab.js');

            const children = await getChildren_internal('1');

            expect(children).toHaveLength(3);
            expect(children.map(c => c.id)).toEqual(['10', '11', '12']);
        });

        test('marks folders with children=true', async () => {
            const { getChildren_internal } = require('../newtab.js');

            const children = await getChildren_internal('1');

            const folderA = children.find(c => c.id === '10');
            const site1 = children.find(c => c.id === '11');
            const folderB = children.find(c => c.id === '12');

            expect(folderA.children).toBe(true);
            expect(site1.children).toBeUndefined();
            expect(folderB.children).toBe(true);
        });

        test('fetches nested folder children correctly', async () => {
            const { getChildren_internal } = require('../newtab.js');

            const children = await getChildren_internal('10');

            expect(children).toHaveLength(3);
            expect(children.map(c => c.id)).toEqual(['100', '101', '102']);
            expect(children[0].url).toBe('https://nested1.com');
            expect(children[2].children).toBe(true); // Nested Folder C is a folder
        });

        test('fetches special folder data from cache (not Chrome APIs)', async () => {
            // Store special folder data in the real cache
            const mockRecent = [
                { id: 'r1', title: 'Recent 1', url: 'https://recent1.com' },
                { id: 'r2', title: 'Recent 2', url: 'https://recent2.com' }
            ];
            await BookmarkCache.setSpecialFolder('recent', mockRecent);
            // Reload in-memory cache to pick up the new data
            // (In production, the service worker writes and newtab.js reads fresh on page load)
            await BookmarkCache.loadAllData(true);

            const { getChildren_internal } = require('../newtab.js');
            const result = await getChildren_internal('recent');

            expect(result).toHaveLength(2);
            expect(result[0].title).toBe('Recent 1');
        });

        test('fetches top sites from Chrome APIs (only special folder that uses API)', async () => {
            // 'top' is the only special folder that fetches from Chrome API
            // because service worker can't access chrome.topSites
            const mockTopSites = [
                { title: 'Site 1', url: 'https://site1.com' },
                { title: 'Site 2', url: 'https://site2.com' }
            ];
            global.chrome.topSites = { get: () => Promise.resolve(mockTopSites) };

            // Ensure no cached data for 'top'
            // (The real BookmarkCache.getSpecialFolder will return null if not set)

            const { getChildren_internal } = require('../newtab.js');
            const result = await getChildren_internal('top');

            expect(result).toHaveLength(2);
            expect(result[0].title).toBe('Site 1');
        });

        test('returns empty array for empty folder', async () => {
            const { getChildren_internal } = require('../newtab.js');

            const children = await getChildren_internal('12'); // Folder B is empty

            expect(children).toHaveLength(0);
        });
    });

    describe('BookmarkCache integration', () => {
        test('getFolder returns correct folder data', async () => {
            const folder = await BookmarkCache.getFolder('1');

            expect(folder.id).toBe('1');
            expect(folder.title).toBe('Bookmarks Bar');
            expect(folder.children).toHaveLength(3);
        });

        test('getCacheStatus returns valid status after population', async () => {
            const status = await BookmarkCache.getCacheStatus();

            expect(status.valid).toBe(true);
            expect(status.version).toBe(BookmarkCache.CACHE_VERSION);
            expect(status.lastSync).toBeGreaterThan(0);
        });

        test('loadAllData loads all folders into memory', async () => {
            const data = await BookmarkCache.loadAllData();

            // Should have folders: 0, 1, 2, 10, 12, 102 + meta records
            expect(data.size).toBeGreaterThanOrEqual(6);
            expect(data.has('folder:1')).toBe(true);
            expect(data.has('folder:10')).toBe(true);
        });
    });

    describe('folder click handlers', () => {
        test('middle-click on folder opens all bookmarks in BACKGROUND tabs and prevents auto-scroll', async () => {
            const { render } = require('../newtab.js');

            // Track chrome.tabs.create calls - must open with active: false for background
            const createdTabs = [];
            global.chrome.tabs.create = (options) => {
                createdTabs.push(options);
                return Promise.resolve({ id: createdTabs.length });
            };

            // Create a folder with children already loaded
            const folderNode = {
                id: '10',
                title: 'Folder A',
                children: [
                    { id: '100', title: 'Nested 1', url: 'https://nested1.com' },
                    { id: '101', title: 'Nested 2', url: 'https://nested2.com' }
                ]
            };

            const ul = document.createElement('ul');
            render(folderNode, ul);

            const folderLink = ul.querySelector('a');
            expect(folderLink).toBeTruthy();

            // Middle-click uses mousedown (not auxclick) to prevent auto-scroll
            const mousedownEvent = new MouseEvent('mousedown', { button: 1, cancelable: true });
            folderLink.dispatchEvent(mousedownEvent);

            // CRITICAL: Must prevent default to stop auto-scroll behavior
            expect(mousedownEvent.defaultPrevented).toBe(true);

            // Wait for async openLinks to complete
            await new Promise(r => setTimeout(r, 50));

            // CRITICAL: Tabs must be opened in background (active: false)
            expect(createdTabs).toHaveLength(2);
            expect(createdTabs[0]).toEqual({ url: 'https://nested1.com', active: false });
            expect(createdTabs[1]).toEqual({ url: 'https://nested2.com', active: false });
        });

        test('Ctrl+click on folder opens all bookmarks in BACKGROUND tabs', async () => {
            const { render } = require('../newtab.js');

            // Track chrome.tabs.create calls - must open with active: false for background
            const createdTabs = [];
            global.chrome.tabs.create = (options) => {
                createdTabs.push(options);
                return Promise.resolve({ id: createdTabs.length });
            };

            // Create a folder with children already loaded
            const folderNode = {
                id: '10',
                title: 'Folder A',
                children: [
                    { id: '100', title: 'Nested 1', url: 'https://nested1.com' },
                    { id: '101', title: 'Nested 2', url: 'https://nested2.com' }
                ]
            };

            const ul = document.createElement('ul');
            render(folderNode, ul);

            const folderLink = ul.querySelector('a');
            expect(folderLink).toBeTruthy();

            // Simulate Ctrl+click
            const ctrlClickEvent = new MouseEvent('click', { ctrlKey: true, bubbles: true });
            folderLink.dispatchEvent(ctrlClickEvent);

            // Wait for async openLinks to complete
            await new Promise(r => setTimeout(r, 50));

            // CRITICAL: Tabs must be opened in background (active: false)
            expect(createdTabs).toHaveLength(2);
            expect(createdTabs[0]).toEqual({ url: 'https://nested1.com', active: false });
            expect(createdTabs[1]).toEqual({ url: 'https://nested2.com', active: false });
        });

        test('regular click on folder toggles it (does not open links)', async () => {
            const { render } = require('../newtab.js');

            // Track window.open calls
            const openedUrls = [];
            global.window.open = (url) => { openedUrls.push(url); };

            // Create a folder with children already loaded
            const folderNode = {
                id: '10',
                title: 'Folder A',
                children: [
                    { id: '100', title: 'Nested 1', url: 'https://nested1.com' },
                    { id: '101', title: 'Nested 2', url: 'https://nested2.com' }
                ]
            };

            const ul = document.createElement('ul');
            render(folderNode, ul);

            const folderLink = ul.querySelector('a');
            expect(folderLink).toBeTruthy();

            // Folder should start closed
            expect(folderLink.open).toBeFalsy();

            // Simulate regular click (no Ctrl)
            const clickEvent = new MouseEvent('click', { bubbles: true });
            folderLink.dispatchEvent(clickEvent);

            // Wait for toggle to complete
            await new Promise(r => setTimeout(r, 50));

            // Folder should now be open
            expect(folderLink.open).toBe(true);

            // No links should have been opened
            expect(openedUrls).toHaveLength(0);
        });
    });

    describe('openLink', () => {
        test('opens chrome:// URLs using chrome.tabs.create with active: true for foreground tabs', async () => {
            const { openLink, TAB } = require('../newtab.js');

            // Track chrome.tabs.create calls
            const createdTabs = [];
            global.chrome.tabs.create = (options) => {
                createdTabs.push(options);
                return Promise.resolve({ id: createdTabs.length });
            };

            // Track window.open calls (should NOT be used for chrome:// URLs)
            const windowOpenCalls = [];
            global.window.open = (url, target) => {
                windowOpenCalls.push({ url, target });
            };

            // Open a chrome:// URL in foreground tab
            // This is what "Edit bookmarks" does
            openLink({ url: 'chrome://bookmarks/?id=10' }, TAB.FOREGROUND);

            // Should use chrome.tabs.create, NOT window.open
            expect(createdTabs).toHaveLength(1);
            expect(createdTabs[0]).toEqual({ url: 'chrome://bookmarks/?id=10', active: true });
            expect(windowOpenCalls).toHaveLength(0);
        });

        test('opens chrome:// URLs using chrome.tabs.create with active: false for background tabs', async () => {
            const { openLink, TAB } = require('../newtab.js');

            // Track chrome.tabs.create calls
            const createdTabs = [];
            global.chrome.tabs.create = (options) => {
                createdTabs.push(options);
                return Promise.resolve({ id: createdTabs.length });
            };

            // Open a chrome:// URL in background tab
            openLink({ url: 'chrome://settings/clearBrowserData' }, TAB.BACKGROUND);

            expect(createdTabs).toHaveLength(1);
            expect(createdTabs[0]).toEqual({ url: 'chrome://settings/clearBrowserData', active: false });
        });
    });

    describe('expandDeferredFolders', () => {
        // Note: This test is skipped because render() requires full module initialization
        // (coords, columns, root variables) which happens during the main page load.
        // The expandDeferredFolders functionality is tested via integration testing in the browser.
        test.skip('expands deferred special folders', async () => {
            localStorage.setItem('options.remember_open', '1');
            localStorage.setItem('open.recent', 'true');
            localStorage.setItem('column.0.0', 'recent');

            // Store recent bookmarks in cache
            const mockRecent = [{ id: 'r1', title: 'Recent 1', url: 'https://r1.com' }];
            await BookmarkCache.setSpecialFolder('recent', mockRecent);

            const { expandDeferredFolders, render } = require('../newtab.js');
            await new Promise(r => setTimeout(r, 50));

            const main = document.getElementById('main');
            main.innerHTML = '';
            const column = document.createElement('div');
            column.className = 'column';
            const ul = document.createElement('ul');
            column.appendChild(ul);
            main.appendChild(column);

            render({ id: 'recent', title: 'Recent bookmarks', children: true }, ul);

            const deferredBefore = document.querySelectorAll('#main a.folder[data-deferred="true"]');
            expect(deferredBefore).toHaveLength(1);

            await expandDeferredFolders();

            const deferredAfter = document.querySelectorAll('#main a.folder[data-deferred="true"]');
            expect(deferredAfter).toHaveLength(0);
        });
    });
});
