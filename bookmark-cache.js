'use strict';

/**
 * IndexedDB-based bookmark cache for fast bookmark loading.
 *
 * Database structure:
 * - Store: 'folders' with keyPath 'key'
 * - Records:
 *   - 'folder:{id}' → { key, id, title, parentId, children: [...] }
 *   - 'meta:version' → { key, value: number }
 *   - 'meta:lastSync' → { key, value: timestamp }
 *
 * This module is used by both:
 * - background.js (service worker) - writes to cache
 * - newtab.js - reads from cache only
 */

const BookmarkCache = {
    DB_NAME: 'BookmarkCache',
    DB_VERSION: 1,
    STORE_NAME: 'folders',
    CACHE_VERSION: 1,

    _db: null,
    _dbPromise: null, // Prevent concurrent openDB calls
    _allDataCache: null, // In-memory cache of all data for fast reads

    /**
     * Open/create the IndexedDB database
     * @returns {Promise<IDBDatabase>}
     */
    async openDB() {
        if (this._db) return this._db;

        // Prevent concurrent openDB calls (race condition fix)
        if (this._dbPromise) return this._dbPromise;

        this._dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

            request.onerror = () => {
                this._dbPromise = null;
                reject(new Error(`Failed to open IndexedDB: ${request.error}`));
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME, {keyPath: 'key'});
                }
            };

            request.onsuccess = () => {
                this._db = request.result;
                this._dbPromise = null;
                resolve(this._db);
            };
        });

        return this._dbPromise;
    },

    /**
     * Load all data into memory cache for fast subsequent reads
     * This is much faster than multiple individual IndexedDB reads
     * @param {boolean} force - Force reload even if cache exists
     * @returns {Promise<Map<string, any>>}
     */
    async loadAllData(force = false) {
        // Return cached data if it exists (cache is valid for entire page session)
        // The cache is only invalidated on writes or explicit force reload
        if (!force && this._allDataCache) {
            console.log('[BookmarkCache] loadAllData: using existing cache');
            return this._allDataCache;
        }

        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const request = store.getAll();

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const cache = new Map();
                const records = request.result;
                for (let i = 0, len = records.length; i < len; i++) {
                    const record = records[i];
                    cache.set(record.key, record);
                }
                this._allDataCache = cache;
                resolve(cache);
            };
        });
    },

    /**
     * Get a single record by key (uses in-memory cache if available)
     * @param {string} key - The record key (e.g., 'folder:1' or 'meta:version')
     * @returns {Promise<any>}
     */
    async get(key) {
        return (await this.getMany([key])).get(key);
    },

    /**
     * Get multiple records by keys (uses in-memory cache if available)
     * @param {string[]} keys - Array of record keys
     * @returns {Promise<Map<string, any>>}
     */
    async getMany(keys) {
        // Try in-memory cache first
        if (!this._allDataCache) await this.loadAllData()

        const results = new Map();
        for (let i = 0, len = keys.length; i < len; i++) {
            const key = keys[i];
            const value = this._allDataCache.get(key);
            if (value) results.set(key, value);
        }
        return results;
    },

    /**
     * Get folder data by folder ID (uses in-memory cache if available)
     * @param {string} folderId - The bookmark folder ID
     * @returns {Promise<{id: string, title: string, parentId: string, children: Array}|null>}
     */
    async getFolder(folderId) {
        const record = await this.get(`folder:${folderId}`);
        return record || null;
    },

    /**
     * Get multiple folders by IDs (uses in-memory cache if available)
     * @param {string[]} folderIds - Array of folder IDs
     * @returns {Promise<Map<string, object>>}
     */
    async getFolders(folderIds) {
        const len = folderIds.length;
        const keys = new Array(len);
        for (let i = 0; i < len; i++) {
            keys[i] = `folder:${folderIds[i]}`;
        }
        const records = await this.getMany(keys);
        const result = new Map();
        // Reuse keys array to avoid duplicate string construction
        for (let i = 0; i < len; i++) {
            const value = records.get(keys[i]);
            if (value) result.set(folderIds[i], value);
        }
        return result;
    },

    /**
     * Store a single record
     * @param {string} key - The record key
     * @param {any} value - The value to store (must include 'key' property)
     * @returns {Promise<void>}
     */
    async put(key, value) {
        value.key = key;
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            const request = store.put(value);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                if (this._allDataCache) {
                    this._allDataCache.set(key, value);
                }
                resolve();
            };
        });
    },

    /**
     * Store multiple records in a single transaction (efficient bulk write)
     * @param {Array<{key: string, value: any}>} records - Array of {key, value} pairs
     * @returns {Promise<void>}
     */
    async putMany(records) {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);

            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => {
                // Update cache in-place if it exists
                if (this._allDataCache) {
                    for (let i = 0; i < records.length; i++){
                        const {key, value} = records[i];
                        this._allDataCache.set(key, {...value, key});
                    }
                }
                resolve();
            };

            for (let i = 0, len = records.length; i < len; i++) {
                const {key, value} = records[i];
                store.put({...value, key});
            }
        });
    },

    /**
     * Clear all data and store new records atomically
     * @param {Array<{key: string, value: any}>} records - Array of {key, value} pairs
     * @returns {Promise<void>}
     */
    async replaceAll(records) {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);

            tx.onerror = () => reject(tx.error);
            tx.oncomplete = () => {
                // Rebuild cache from the records we just wrote
                this._allDataCache = new Map();
                for (let i = 0, len = records.length; i < len; i++) {
                    const {key, value} = records[i];
                    this._allDataCache.set(key, {...value, key});
                }
                resolve();
            };

            // Clear all existing data first
            store.clear();

            for (let i = 0, len = records.length; i < len; i++) {
                const {key, value} = records[i];
                store.put({...value, key});
            }
        });
    },

    /**
     * Check if cache exists and is valid
     * @returns {Promise<{valid: boolean, lastSync: number|null, version: number|null}>}
     */
    async getCacheStatus() {
        try {
            const versionRecord = await this.get('meta:version');
            const syncRecord = await this.get('meta:lastSync');
            const version = versionRecord?.value ?? null;
            const lastSync = syncRecord?.value ?? null;
            const valid = version === this.CACHE_VERSION && lastSync !== null;

            return {valid, lastSync, version};
        } catch (e) {
            return {valid: false, lastSync: null, version: null};
        }
    },


    /**
     * Clear all cached data
     * @visibleForTests
     * @returns {Promise<void>}
     */
    async clear() {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            const request = store.clear();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                // Clear the cache too
                this._allDataCache = new Map();
                resolve();
            };
        });
    },

    /**
     * Close the database connection
     */
    close() {
        if (this._db) {
            this._db.close();
            this._db = null;
        }
    },

    // =========================================================================
    // SYNC HELPERS - Used by background.js to populate the cache
    // =========================================================================

    /**
     * Flatten a bookmark tree into folder records
     * @param {Array} tree - Result from chrome.bookmarks.getTree()
     * @returns {Array<{key: string, value: object}>} Records ready for putMany/replaceAll
     */
    flattenTree(tree) {
        const records = [];

        function processNode(node, parentId, id = node.id) {
            // Only process folders (nodes without url)
            if (!node.url) {
                const nodeChildren = node.children || [];
                const childLen = nodeChildren.length;
                const children = new Array(childLen);
                for (let j = 0; j < childLen; j++) {
                    const child = nodeChildren[j];
                    children[j] = {
                        id: child.id,
                        title: child.title,
                        url: child.url,
                        // Mark as folder if no url
                        ...(child.url ? {} : {isFolder: true})
                    };
                }

                records.push({
                    key: 'folder:' + id,
                    value: {
                        id: id,
                        title: node.title,
                        parentId: parentId,
                        children: children
                    }
                });

                // Recursively process child folders
                for (let i = 0; i < childLen; i++) {
                    const child = nodeChildren[i];
                    if (!child.url) {
                        processNode(child, id);
                    }
                }
            }
        }

        // Process root with normalized ID '0' (Firefox uses 'root________', Chrome uses '0')
        if (tree.length > 0) {
            processNode(tree[0], null, '0');
        }

        return records;
    },

    /**
     * Perform a full sync from chrome.bookmarks.getTree()
     * This should only be called from the service worker
     * @returns {Promise<{folderCount: number, syncTime: number}>}
     */
    async fullSync() {
        // Get the full bookmark tree
        const tree = await chrome.bookmarks.getTree();

        // Flatten to records
        const folderRecords = this.flattenTree(tree);

        // Pre-compute recent bookmarks from the tree
        const recentBookmarks = this.extractRecentBookmarks(tree, 20);

        // Add metadata
        const now = Date.now();
        const allRecords = [
            ...folderRecords,
            {key: 'meta:version', value: {value: this.CACHE_VERSION}},
            {key: 'meta:lastSync', value: {value: now}},
            // Pre-cache recent bookmarks (no TTL needed - refreshed on every sync)
            {key: 'special:recent', value: {data: recentBookmarks, cachedAt: now}}
        ];

        // Replace all data atomically
        await this.replaceAll(allRecords);

        return folderRecords.length;
    },

    // =========================================================================
    // SPECIAL FOLDER CACHING - Cache special folder data with TTL
    // =========================================================================

    // TTL values in milliseconds
    SPECIAL_TTL: {
        top: 10 * 60 * 1000,    // 10 minutes for top sites
        recent: Infinity,       // Recent bookmarks: no TTL (refreshed on bookmark sync)

        closed: 60 * 1000,  // 1 minute for recently closed
        devices: 60 * 1000  // 1 minute for other devices
    },

    /**
     * Extract recent bookmarks from the full tree (sorted by dateAdded)
     * @param {Array} tree - Result from chrome.bookmarks.getTree()
     * @param {number} limit - Maximum number of bookmarks to return
     * @returns {Array} Recent bookmarks sorted by dateAdded descending
     */
    extractRecentBookmarks(tree, limit = 20) {
        const bookmarks = [];

        function collectBookmarks(node) {
            if (node.url && node.dateAdded) {
                bookmarks.push({
                    id: node.id,
                    title: node.title,
                    url: node.url,
                    dateAdded: node.dateAdded
                });
            }
            if (node.children) {
                for (let i = 0; i < node.children.length; i++) {
                    const child = node.children[i];
                    collectBookmarks(child);
                }
            }
        }

        for (let i = 0; i < tree.length; i++) {
            const node = tree[i];
            collectBookmarks(node);
        }

        // Sort by dateAdded descending and take top N
        bookmarks.sort((a, b) => b.dateAdded - a.dateAdded);
        return bookmarks.slice(0, limit);
    },

    /**
     * Get cached special folder data if not expired
     * @param {string} specialId - Special folder ID (top, recent, closed, devices)
     * @returns {Promise<{data: Array, fresh: boolean}|null>} Cached data or null if expired/missing
     */
    async getSpecialFolder(specialId) {
        const record = await this.get('special:' + specialId);
        if (!record) return null;

        const ttl = this.SPECIAL_TTL[specialId];
        const age = Date.now() - (record.cachedAt || 0);
        const fresh = age < ttl;

        return {data: record.data || [], fresh};
    },

    /**
     * Store special folder data with timestamp
     * @param {string} specialId - Special folder ID
     * @param {Array} data - The folder children data
     * @returns {Promise<void>}
     */
    async setSpecialFolder(specialId, data) {
        await this.put('special:' + specialId, {
            data,
            cachedAt: Date.now()
        });
    }
};

// Export for both browser and Node.js (testing)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = BookmarkCache;
}
