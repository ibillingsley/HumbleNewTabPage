/**
 * Unit tests for bookmark-cache.js
 * @jest-environment jsdom
 */

'use strict';

// Polyfill structuredClone for Node.js test environment
if (typeof structuredClone === 'undefined') {
    global.structuredClone = (obj) => JSON.parse(JSON.stringify(obj));
}

// Mock IndexedDB using fake-indexeddb
require('fake-indexeddb/auto');

const BookmarkCache = require('../bookmark-cache.js');

describe('BookmarkCache', () => {
    beforeEach(async () => {
        // Close any existing connection first
        BookmarkCache.close();
        // Reset the cache state before each test
        BookmarkCache._db = null;
        // Open fresh database and clear it
        await BookmarkCache.openDB();
        await BookmarkCache.clear();
    });

    afterEach(() => {
        BookmarkCache.close();
    });

    describe('openDB', () => {
        test('creates database and object store', async () => {
            const db = await BookmarkCache.openDB();
            expect(db).toBeDefined();
            expect(db.objectStoreNames.contains(BookmarkCache.STORE_NAME)).toBe(true);
        });

        test('returns same database on subsequent calls', async () => {
            const db1 = await BookmarkCache.openDB();
            const db2 = await BookmarkCache.openDB();
            expect(db1).toBe(db2);
        });
    });

    describe('put and get', () => {
        test('stores and retrieves a record', async () => {
            await BookmarkCache.put('test:1', { value: 'hello' });
            const result = await BookmarkCache.get('test:1');
            expect(result).toEqual({ key: 'test:1', value: 'hello' });
        });

        test('returns undefined for non-existent key', async () => {
            const result = await BookmarkCache.get('nonexistent');
            expect(result).toBeUndefined();
        });
    });

    describe('getMany', () => {
        test('retrieves multiple records', async () => {
            await BookmarkCache.put('test:1', { value: 'one' });
            await BookmarkCache.put('test:2', { value: 'two' });
            await BookmarkCache.put('test:3', { value: 'three' });

            const results = await BookmarkCache.getMany(['test:1', 'test:3']);
            expect(results.size).toBe(2);
            expect(results.get('test:1').value).toBe('one');
            expect(results.get('test:3').value).toBe('three');
        });

        test('returns empty map for empty keys array', async () => {
            const results = await BookmarkCache.getMany([]);
            expect(results.size).toBe(0);
        });
    });

    describe('getFolder and getFolders', () => {
        test('retrieves folder by ID', async () => {
            const folder = {
                id: '1',
                title: 'Bookmarks Bar',
                parentId: '0',
                children: [{ id: '10', title: 'Site 1', url: 'https://example.com' }]
            };
            await BookmarkCache.put('folder:1', folder);

            const result = await BookmarkCache.getFolder('1');
            expect(result.id).toBe('1');
            expect(result.title).toBe('Bookmarks Bar');
            expect(result.children).toHaveLength(1);
        });

        test('returns null for non-existent folder', async () => {
            const result = await BookmarkCache.getFolder('999');
            expect(result).toBeNull();
        });

        test('retrieves multiple folders', async () => {
            await BookmarkCache.put('folder:1', { id: '1', title: 'Folder 1' });
            await BookmarkCache.put('folder:2', { id: '2', title: 'Folder 2' });

            const results = await BookmarkCache.getFolders(['1', '2']);
            expect(results.size).toBe(2);
            expect(results.get('1').title).toBe('Folder 1');
            expect(results.get('2').title).toBe('Folder 2');
        });
    });

    describe('putMany', () => {
        test('stores multiple records in one transaction', async () => {
            await BookmarkCache.putMany([
                { key: 'test:1', value: { data: 'one' } },
                { key: 'test:2', value: { data: 'two' } },
                { key: 'test:3', value: { data: 'three' } }
            ]);

            const r1 = await BookmarkCache.get('test:1');
            const r2 = await BookmarkCache.get('test:2');
            const r3 = await BookmarkCache.get('test:3');

            expect(r1.data).toBe('one');
            expect(r2.data).toBe('two');
            expect(r3.data).toBe('three');
        });
    });

    describe('replaceAll', () => {
        test('clears existing data and stores new records', async () => {
            // Add initial data
            await BookmarkCache.put('old:1', { value: 'old' });

            // Replace with new data
            await BookmarkCache.replaceAll([
                { key: 'new:1', value: { data: 'new1' } },
                { key: 'new:2', value: { data: 'new2' } }
            ]);

            // Old data should be gone
            const oldResult = await BookmarkCache.get('old:1');
            expect(oldResult).toBeUndefined();

            // New data should exist
            const newResult = await BookmarkCache.get('new:1');
            expect(newResult.data).toBe('new1');
        });
    });

    describe('getCacheStatus', () => {
        test('returns invalid when cache is empty', async () => {
            const status = await BookmarkCache.getCacheStatus();
            expect(status.valid).toBe(false);
            expect(status.lastSync).toBeNull();
            expect(status.version).toBeNull();
        });

        test('returns valid when metadata exists', async () => {
            await BookmarkCache.put('meta:version', { value: BookmarkCache.CACHE_VERSION });
            await BookmarkCache.put('meta:lastSync', { value: Date.now() });

            const status = await BookmarkCache.getCacheStatus();
            expect(status.valid).toBe(true);
            expect(status.version).toBe(BookmarkCache.CACHE_VERSION);
            expect(status.lastSync).toBeGreaterThan(0);
        });
    });

    describe('clear', () => {
        test('removes all data', async () => {
            await BookmarkCache.put('test:1', { value: 'one' });
            await BookmarkCache.put('test:2', { value: 'two' });

            await BookmarkCache.clear();

            const r1 = await BookmarkCache.get('test:1');
            const r2 = await BookmarkCache.get('test:2');
            expect(r1).toBeUndefined();
            expect(r2).toBeUndefined();
        });
    });

    describe('flattenTree', () => {
        test('flattens bookmark tree into folder records', () => {
            const tree = [{
                id: '0',
                title: '',
                children: [
                    {
                        id: '1',
                        title: 'Bookmarks Bar',
                        children: [
                            { id: '10', title: 'Site 1', url: 'https://example.com' },
                            { id: '11', title: 'Folder A', children: [
                                { id: '100', title: 'Nested', url: 'https://nested.com' }
                            ]}
                        ]
                    },
                    {
                        id: '2',
                        title: 'Other Bookmarks',
                        children: []
                    }
                ]
            }];

            const records = BookmarkCache.flattenTree(tree);

            // Should have 4 folders: 0, 1, 11, 2
            expect(records.length).toBe(4);

            // Check root folder
            const root = records.find(r => r.key === 'folder:0');
            expect(root).toBeDefined();
            expect(root.value.children).toHaveLength(2);

            // Check Bookmarks Bar
            const bar = records.find(r => r.key === 'folder:1');
            expect(bar).toBeDefined();
            expect(bar.value.title).toBe('Bookmarks Bar');
            expect(bar.value.children).toHaveLength(2);
            expect(bar.value.children[0].url).toBe('https://example.com');
            expect(bar.value.children[1].isFolder).toBe(true);

            // Check nested folder
            const nested = records.find(r => r.key === 'folder:11');
            expect(nested).toBeDefined();
            expect(nested.value.parentId).toBe('1');
        });

        test('normalizes Firefox root folder ID to 0', () => {
            // Firefox uses 'root________' as the root folder ID
            const firefoxTree = [{
                id: 'root________',
                title: '',
                children: [
                    {
                        id: 'menu________',
                        title: 'Bookmarks Menu',
                        children: [
                            { id: 'abc123', title: 'Site 1', url: 'https://example.com' }
                        ]
                    },
                    {
                        id: 'toolbar_____',
                        title: 'Bookmarks Toolbar',
                        children: []
                    }
                ]
            }];

            const records = BookmarkCache.flattenTree(firefoxTree);

            // Root folder should be normalized to '0'
            const root = records.find(r => r.key === 'folder:0');
            expect(root).toBeDefined();
            expect(root.value.id).toBe('0');
            expect(root.value.children).toHaveLength(2);

            // Child folders should keep their original IDs but have normalized parent
            const menu = records.find(r => r.key === 'folder:menu________');
            expect(menu).toBeDefined();
            expect(menu.value.parentId).toBe('0');

            const toolbar = records.find(r => r.key === 'folder:toolbar_____');
            expect(toolbar).toBeDefined();
            expect(toolbar.value.parentId).toBe('0');
        });
    });

    describe('fullSync', () => {
        beforeEach(() => {
            // Mock chrome.bookmarks.getTree
            global.chrome = {
                bookmarks: {
                    getTree: () => Promise.resolve([{
                        id: '0',
                        title: '',
                        children: [
                            {
                                id: '1',
                                title: 'Bookmarks Bar',
                                children: [
                                    { id: '10', title: 'Site 1', url: 'https://example.com' }
                                ]
                            }
                        ]
                    }])
                }
            };
        });

        test('syncs bookmarks to cache', async () => {
            await BookmarkCache.fullSync();

            // Verify data was stored
            const folder = await BookmarkCache.getFolder('1');
            expect(folder.title).toBe('Bookmarks Bar');
            expect(folder.children).toHaveLength(1);

            // Verify metadata
            const status = await BookmarkCache.getCacheStatus();
            expect(status.valid).toBe(true);
        });
    });
});
