'use strict';

// Tab open mode enum
const TAB_OPEN_MODE = Object.freeze({
    CURRENT: 0,
    FOREGROUND: 1,
    BACKGROUND: 2
});

// =============================================================================
// SPECIAL FOLDERS - Unified handling for top sites, recent, closed, devices
// =============================================================================

const SpecialFolders = {
    // Definition of all special folders with their properties
    defs: {
        top: {title: 'Most visited', isFolder: true, configKey: 'number_top'},
        recent: {title: 'Recent bookmarks', isFolder: true, configKey: 'number_recent'},
        closed: {title: 'Recently closed', isFolder: true, configKey: 'number_closed'},
        devices: {title: 'Other devices', isFolder: true, configKey: 'number_closed'}
    },

    // All special IDs (for iteration)
    all: ['top', 'recent', 'closed', 'devices'],

    // Pre-computed Set for O(1) lookups (all special folders are also folders)
    _specialSet: new Set(['top', 'recent', 'closed', 'devices']),

    // Check if an ID is a special folder (O(1) Set lookup)
    isSpecial(id) {
        return this._specialSet.has(id);
    },

    // Get node definition for rendering
    getNode(id) {
        const def = this.defs[id];
        if (!def) return null;
        return {
            id,
            title: def.title,
            url: def.url,
            children: def.isFolder ? true : undefined
        };
    },

    // Fetch children data for a special folder
    // ONLY reads from IndexedDB cache - no Chrome API fallback
    // Exception: 'top' sites must be fetched here (SW can't access chrome.topSites)
    async fetchChildrenOfSpecialFolder(id) {
        const def = this.defs[id];
        if (!def?.isFolder) return [];
        const limit = getConfig(def.configKey);

        // 'top' is special - SW can't cache it, so we fetch and cache here
        if (id === 'top') {
            return this._fetchTopSites(limit);
        }

        // All other special folders: read from cache only, no API fallback
        const cached = await BookmarkCache.getSpecialFolder(id);
        if (cached?.data) {
            return this._hydrateData(id, cached.data.slice(0, limit));
        }

        // Cache miss - return empty, don't call Chrome APIs
        return [];
    },

    // Fetch top sites (only special folder that newtab.js fetches directly)
    async _fetchTopSites(limit) {
        // Try cache first
        const cached = await BookmarkCache.getSpecialFolder('top');
        if (cached?.fresh) {
            return cached.data.slice(0, limit);
        }

        // Cache miss or stale - fetch from API (only for 'top')
        if (!chrome.topSites) return [];

        const freshData = await chrome.topSites.get().then(r => r || []);

        // Cache for next time
        BookmarkCache.setSpecialFolder('top', freshData).catch(e =>
            console.warn(`[SpecialFolders] Failed to cache top:`, e));

        return freshData.slice(0, limit);
    },

    // Hydrate cached data with runtime properties (action callbacks, className)
    _hydrateData(id, data) {
        if (id === 'closed') {
            const len = data.length;
            const result = new Array(len);
            for (let i = 0; i < len; i++) {
                const item = data[i];
                result[i] = {
                    ...item,
                    className: item.isWindow ? 'window' : null,
                    action: () => {
                        chrome.sessions.restore(item.sessionId);
                        refreshClosed();
                        return false;
                    }
                };
            }
            return result;
        }
        // 'top', 'recent', 'devices' don't need hydration
        return data;
    }
};

// Convenience references
const special = SpecialFolders.all;
const specialFolderIds = [];
for (let i = 0, len = special.length; i < len; i++) {
    const id = special[i];
    if (SpecialFolders.isSpecial(id)) specialFolderIds.push(id);
}

// =============================================================================
// BOOKMARK LOADING - Load from IndexedDB cache (populated by service worker)
// =============================================================================

// Cache loading state
let cacheLoadError = null;
let cacheStatus = null;

/**
 * Check if the bookmark cache is available and valid
 * @returns {Promise<{valid: boolean, lastSync: number|null, version: number|null}>}
 */
async function checkCacheStatus() {
    if (cacheStatus) return cacheStatus;
    try {
        cacheStatus = await BookmarkCache.getCacheStatus();
        return cacheStatus;
    } catch (e) {
        cacheLoadError = e;
        return {valid: false, lastSync: null, version: null};
    }
}

/**
 * Get root folder IDs from cache
 * @returns {Promise<string[]>}
 */
async function getRootFolderIds() {
    const folder = await BookmarkCache.getFolder('0');
    if (!folder || !folder.children) return [];
    const children = folder.children;
    const len = children.length;
    const result = [];
    for (let i = 0; i < len; i++) {
        const c = children[i];
        if (c.isFolder) result.push(c.id);
    }
    return result;
}

// Iterate over column storage entries, calling fn(x, y, id) for each
// If fn returns false, stop iteration.
function forEachColumnEntry(fn) {
    for (let x = 0; ; x++) {
        let foundInRow = false;
        for (let y = 0; ; y++) {
            const id = localStorage.getItem(`column.${x}.${y}`);
            if (id) {
                foundInRow = true;
                if (fn(x, y, id) === false) return;
            } else {
                break;
            }
        }
        if (!foundInRow) break;
    }
}

// Get children for a folder (works for both regular and special folders)
// Uses BookmarkCache's in-memory cache for regular bookmarks (fast after loadAllData)
async function getChildren_internal(id) {
    // Special folders use Chrome APIs (fetched fresh each time)
    if (SpecialFolders.isSpecial(id)) {
        return SpecialFolders.fetchChildrenOfSpecialFolder(id);
    }

    // Regular bookmarks: load from BookmarkCache (uses in-memory cache)
    let children = [];
    try {
        const folder = await BookmarkCache.getFolder(id);
        children = folder ? folder.children : [];
    } catch (e) {
        console.error(`[BookmarkCache] Error loading folder ${id}:`, e);
        cacheLoadError = e;
    }

    for (let i = 0, len = children.length; i < len; i++) {
        if (children[i].isFolder) children[i].children = true;
    }
    return children;
}

// Get node metadata (uses BookmarkCache's in-memory cache)
async function getNode_internal(id) {
    const folder = await BookmarkCache.getFolder(id);
    if (folder) {
        return {id: folder.id, title: folder.title, parentId: folder.parentId};
    }
    return null;
}

// render a single bookmark node
function render(node, target) {
    if (node.description === 'separator') return;

    const li = document.createElement('li');
    const a = document.createElement('a');
    const {url, children, id} = node;

    if (url) {
        a.href = url;
    } else {
        a.tabIndex = 0;
    }

    a.textContent = node.title ?? node.name ?? url ?? '';

    if (node.tooltip) a.title = node.tooltip;
    setClass(a, node);
    a.prepend(getIcon(node)); // Modern API, cleaner than insertBefore

    // Cache newtab config outside conditionals to avoid repeated lookups
    const newtab = url ? getConfig('newtab') : 0;

    if (node.action) {
        a.onclick = node.action;
    } else if (url) {
        if (newtab === TAB_OPEN_MODE.FOREGROUND) {
            a.target = '_blank';
        } else if (newtab === TAB_OPEN_MODE.BACKGROUND) {
            a.onclick = () => {
                openLink(node, newtab);
                return false;
            };
        }
        // Handle chrome:// and file:/// urls that need special opening
        // Use charCodeAt for faster check than startsWith
        const firstChar = url.charCodeAt(0);
        if (firstChar === 99 || firstChar === 102) { // 'c' or 'f'
            a.onclick = e => {
                openLink(node, newtab || (e.ctrlKey ? TAB_OPEN_MODE.BACKGROUND : TAB_OPEN_MODE.CURRENT));
                return false;
            };
            a.onauxclick = e => {
                if (e.button === 1) {
                    openLink(node, TAB_OPEN_MODE.BACKGROUND);
                    return false;
                }
            };
        }
    } else if (!children) {
        a.style.pointerEvents = 'none';
    }

    li.append(a); // Modern API

    // folder
    if (children) {
        // Store node ID for deferred loading (dataset may not exist in test env)
        if (li.dataset) li.dataset.nodeId = id;

        // Check if this folder should auto-expand (show_root=false case)
        if (node.autoExpand && a.dataset) {
            a.dataset.autoExpand = 'true';
        }

        // Check if folder should be open
        const shouldBeOpen = a.open || (getConfig('remember_open') && localStorage.getItem(`open.${id}`));
        if (shouldBeOpen) {
            setClass(a, node, true);
            a.open = true;
            // If children are already loaded as an array, render them immediately
            if (Array.isArray(children)) {
                renderAll(children, li);
            } else if (SpecialFolders.isSpecial(id)) {
                // Special folders require slow Chrome API calls - defer loading
                a.dataset.deferred = 'true';
            } else {
                // Regular bookmarks: fetch children from BookmarkCache (fast, in-memory)
                (async () => {
                    const folderChildren = await getChildren_internal(id);
                    if (a.open && !a.nextSibling) {
                        renderAll(folderChildren, li);
                    }
                })();
            }
        }
        addFolderHandlers(node, a);
        enableDragFolder(node, a);
    }

    target.append(li); // Modern API
    return li;
}

// render an array of bookmark nodes
function renderAll(nodes, target, toplevel) {
    // Use DocumentFragment for batch DOM operations (faster than direct appends)
    const fragment = document.createDocumentFragment();
    const ul = document.createElement('ul');

    for (let i = 0, len = nodes.length; i < len; i++) {
        const node = nodes[i];
        // skip extensions and duplicated child folders
        if (toplevel || !coords[node.id]) render(node, ul);
    }
    // Use firstChild check instead of childNodes.length (faster)
    if (!ul.firstChild) {
        render({id: 'empty', title: '< Empty >'}, ul);
    }
    if (toplevel) {
        fragment.append(ul);
        target.append(fragment);
    } else {
        // wrap child ul for animation
        const wrap = document.createElement('div');
        wrap.append(ul);
        fragment.append(wrap);
        target.append(fragment);
    }
    updateTooltips();
    return ul;
}

// render column with given index
async function renderColumn(index, target) {
    const ids = columns[index];
    if (ids.length === 1 && !getConfig('show_root')) {
        // Single folder with show_root=false: render children directly
        const result = await getChildren({id: ids[0]});
        renderAll(result, target);
        addColumnHandlers(index, target);
    } else if (ids.length > 0) {
        const len = ids.length;
        const promises = new Array(len);
        for (let i = 0; i < len; i++) {
            promises[i] = getSubTree(ids[i]);
        }
        const results = await Promise.all(promises);
        // Flatten results with for loop (faster than flat())
        const nodes = [];
        for (let i = 0; i < len; i++) {
            const arr = results[i];
            for (let j = 0, jLen = arr.length; j < jLen; j++) {
                nodes.push(arr[j]);
            }
        }
        renderAll(nodes, target, true);
        addColumnHandlers(index, target);
    }
}

// Cached DOM element references (avoid repeated getElementById calls)
let mainElement = null;

function getMainElement() {
    return mainElement ??= document.getElementById('main');
}

// render all columns to main div
async function renderColumns() {
    const target = getMainElement();
    target.replaceChildren(); // Modern way to clear children

    // Create all column containers first (fast, synchronous)
    const columnCount = columns.length;
    const columnWidth = `${(1 / columnCount) * 100}%`;
    const columnElements = new Array(columnCount);
    for (let i = 0; i < columnCount; i++) {
        const column = document.createElement('div');
        column.className = 'column';
        column.style.width = columnWidth;
        enableDragColumn(i, column);
        target.append(column);
        columnElements[i] = column;
    }

    // Render all columns in parallel and wait for completion
    const renderPromises = new Array(columnCount);
    for (let i = 0; i < columnCount; i++) {
        renderPromises[i] = renderColumn(i, columnElements[i]);
    }
    await Promise.all(renderPromises);

    enableDragDrop();
}

// Expand special folders that were deferred during initial render
// Special folders (top, recent, closed, devices) require slow Chrome API calls
async function expandDeferredFolders() {
    // Handle deferred special folders (marked with data-deferred="true")
    const deferredLinks = document.querySelectorAll('#main a.folder[data-deferred="true"]');
    const linkCount = deferredLinks.length;
    if (linkCount === 0) return;

    const promises = new Array(linkCount);
    for (let i = 0; i < linkCount; i++) {
        const a = deferredLinks[i];
        promises[i] = (async () => {
            const li = a.parentNode;
            const nodeId = li?.dataset?.nodeId;
            if (!nodeId || !a.open || a.nextSibling) return;

            delete a.dataset.deferred;
            const folderName = a.textContent || nodeId;
            const children = await getChildren({id: nodeId, children: true}, folderName);
            if (a.open && !a.nextSibling) {
                renderAll(children, li);
            }
        })();
    }

    await Promise.all(promises);
}

// enables click and context menu for given folder
function addFolderHandlers(node, a) {
    // click handler - Ctrl+click opens all bookmarks in folder
    a.onclick = e => {
        if (e.ctrlKey) {
            openLinks(node);
        } else {
            toggle(node, a);
        }
        return false;
    };

    // middle-click opens all bookmarks in folder (must use mousedown to prevent auto-scroll)
    a.onmousedown = e => {
        if (e.button === 1) {
            e.preventDefault();
            openLinks(node);
        }
    };

    // context menu handler
    const items = getMenuItems(node);

    // column layout items
    if (!getConfig('lock')) {
        items.push(null); // spacer
        items.push({label: 'Create new column', action: () => addColumn([node.id])});

        const pos = coords[node.id];
        if (pos && columns[pos.x]) {
            if (pos.y > 0)
                items.push({label: 'Move folder up', action: () => addRow(node.id, pos.x, pos.y - 1)});
            if (pos.y < columns[pos.x].length - 1)
                items.push({label: 'Move folder down', action: () => addRow(node.id, pos.x, pos.y + 2)});
            if (pos.x > 0)
                items.push({label: 'Move folder left', action: () => addRow(node.id, pos.x - 1)});
            if (pos.x < columns.length - 1)
                items.push({label: 'Move folder right', action: () => addRow(node.id, pos.x + 1)});
            if (!rootSet?.has(node.id))
                items.push({label: 'Remove folder', action: () => removeRow(pos.x, pos.y)});
        }
    }

    a.oncontextmenu = e => {
        renderMenu(items, e.pageX, e.pageY);
        return false;
    };
}

// enables context menu for given column
function addColumnHandlers(index, ul) {
    const ids = columns[index];
    let items = ids.length === 1 ? getMenuItems({id: ids[0]}) : [];

    // column layout items
    if (!getConfig('lock') && columns.length > 1) {
        items.push(null); // spacer
        if (index > 0)
            items.push({label: 'Move column left', action: () => addColumn(ids, index - 1)});
        if (index < columns.length - 1)
            items.push({label: 'Move column right', action: () => addColumn(ids, index + 2)});
        items.push({label: 'Remove column', action: () => removeColumn(index)});
        if (ids.length === 1) {
            if (index > 0)
                items.push({label: 'Move folder left', action: () => addRow(ids[0], index - 1)});
            if (index < columns.length - 1)
                items.push({label: 'Move folder right', action: () => addRow(ids[0], index + 1)});
        }
    }

    if (items.length > 0) {
        ul.oncontextmenu = e => {
            if (e.target.tagName === 'A' || e.target.parentNode.tagName === 'A') return true;
            renderMenu(items, e.pageX, e.pageY);
            return false;
        };
    }
}

// gets context menu items for given node
function getMenuItems(node) {
    const items = [{label: 'Open all links in folder', action: () => openLinks(node)}];
    if (node.id === 'closed')
        items.push({label: 'Clear browsing data', action: () => openLink({url: `chrome://settings/clearBrowserData`}, TAB_OPEN_MODE.FOREGROUND)});
    if (node.id === 'devices')
        items.push({label: 'History', action: () => openLink({url: `chrome://history`}, TAB_OPEN_MODE.FOREGROUND)});
    if (+node.id > 0)
        items.push({label: 'Edit bookmarks', action: () => openLink({url: `chrome://bookmarks/?id=${node.id}`}, TAB_OPEN_MODE.FOREGROUND)});
    return items;
}

// renders a popup menu at given coordinates
function renderMenu(items, x, y) {
    const ul = document.createElement('ul');
    ul.className = 'menu';

    // Use DocumentFragment to batch DOM operations
    const fragment = document.createDocumentFragment();
    const len = items.length;
    const lastIndex = len - 1;
    for (let i = 0; i < len; i++) {
        const item = items[i];
        if (!item) {
            // Spacer - only add if not at start or end
            if (i > 0 && i < lastIndex) {
                const li = document.createElement('li');
                li.append(document.createElement('hr'));
                fragment.append(li);
            }
            continue;
        }
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.textContent = item.label;
        a.tabIndex = 0;
        a.onclick = () => {
            item.action();
            return false;
        };
        li.append(a);
        fragment.append(li);
    }
    ul.append(fragment);

    document.body.append(ul);
    ul.style.left = `${Math.max(Math.min(x, window.innerWidth + window.scrollX - ul.clientWidth), 0)}px`;
    ul.style.top = `${Math.max(Math.min(y, window.innerHeight + window.scrollY - ul.clientHeight), 0)}px`;
    ul.onmousedown = e => {
        e.stopPropagation();
        return true;
    };

    setTimeout(() => {
        const closeHandler = () => {
            closeMenu(ul);
            return true;
        };
        document.onclick = closeHandler;
        document.onmousedown = closeHandler;
        document.oncontextmenu = closeHandler;
        document.onkeydown = e => {
            if (e.key === 'Escape') closeMenu(ul);
            return true;
        };
    }, 20);
    return ul;
}

// removes the given popup menu
function closeMenu(ul) {
    ul.remove();
    document.onclick = null;
    document.onmousedown = null;
    document.oncontextmenu = null;
    document.onkeydown = null;
}

let dragIds;
let dropTarget;

// enable drag and drop of column
function enableDragColumn(id, column) {
    if (getConfig('lock')) return;

    column.draggable = true;
    column.ondragstart = e => {
        dragIds = columns[id];
        e.dataTransfer.effectAllowed = 'move';
        column.classList.add('dragstart');
    };
    column.ondragend = () => {
        dragIds = null;
        column.classList.remove('dragstart');
        clearDropTarget();
    };
}

// enable drag and drop of folder
function enableDragFolder(node, a) {
    if (getConfig('lock')) return;

    a.draggable = true;
    a.ondragstart = e => {
        dragIds = [node.id];
        e.stopPropagation();
        e.dataTransfer.effectAllowed = 'move copy';
        a.classList.add('dragstart');
    };
    a.ondragend = () => {
        dragIds = null;
        a.classList.remove('dragstart');
        clearDropTarget();
    };
}

// init drag and drop handlers
function enableDragDrop() {
    const main = getMainElement();

    if (getConfig('lock')) {
        main.ondragover = main.ondragleave = main.ondrop = null;
        return;
    }

    main.ondragover = e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const target = getDropTarget(e);
        if (target) {
            clearDropTarget();
            dropTarget = target;
            const bordercss = `solid 2px ${getConfig('font_color')}`;
            if (target.tagName === 'LI' || target.tagName === 'UL') {
                if (isAbove(e.pageY, target)) {
                    target.style.borderBottom = bordercss;
                    target.style.margin = '0 0 -2px 0';
                } else {
                    target.style.borderTop = bordercss;
                    target.style.margin = '-2px 0 0 0';
                }
            } else if (target.className === 'column') {
                if (e.pageX - target.offsetLeft > target.clientWidth / 2) {
                    target.style.borderRight = bordercss;
                    target.style.margin = '0';
                } else {
                    target.style.borderLeft = bordercss;
                    target.style.margin = '0 2px 0 -2px';
                }
            }
        }
        return false;
    };

    main.ondragleave = () => clearDropTarget();

    main.ondrop = e => {
        e.stopPropagation();
        const target = getDropTarget(e);
        if (!target) return false;

        let x = getDropX(target);
        const y = getDropY(target, e);

        if (dragIds.length === 1 && y != null) {
            addRow(dragIds[0], x, y);
        } else {
            if (e.pageX - target.offsetLeft > target.clientWidth / 2) x++;
            addColumn(dragIds, x);
        }
        return false;
    };
}

// gets proper drop target element
function getDropTarget(event) {
    if (!dragIds) return null;

    let target = event.target;
    if (target && (target.tagName === 'A' || target.parentNode.tagName === 'A') && dragIds.length === 1) {
        // get parent folder until toplevel
        while (target?.parentNode?.parentNode?.className !== 'column') {
            target = target.parentNode;
        }
        // if single-folder column, get the UL
        if (target?.tagName === 'LI' && columns[getDropX(target)].length === 1) {
            target = target.parentNode;
        }
    } else {
        while (target && target.className !== 'column') {
            target = target.parentNode;
        }
    }
    return target;
}

// gets x coordinate of drop target
function getDropX(target) {
    while (target && target.className !== 'column') {
        target = target.parentNode;
    }
    if (!target) return null;

    // Use Array.prototype.indexOf for O(1) lookup instead of O(n) sibling traversal
    return Array.prototype.indexOf.call(target.parentNode.children, target);
}

// gets y coordinate of drop target
function getDropY(target, event) {
    if (target.tagName !== 'LI' && target.tagName !== 'UL') return null;
    let y = isAbove(event.pageY, target) ? 1 : 0;
    if (target.tagName === 'LI') {
        // Use Array.prototype.indexOf for O(1) lookup instead of O(n) sibling traversal
        const siblings = target.parentNode.children;
        y += Array.prototype.indexOf.call(siblings, target);
    }
    return y;
}

// returns true if y position is above target element midpoint
const isAbove = (pageY, target) =>
    pageY - window.scrollY - target.getBoundingClientRect().top > target.clientHeight / 2;

// clears droptarget styles
function clearDropTarget() {
    if (dropTarget) {
        Object.assign(dropTarget.style, {border: null, margin: null});
    }
    dropTarget = null;
}

let tooltipTimeout = null;

// adds tooltips to truncated text - uses requestIdleCallback for non-blocking updates
function updateTooltips() {
    if (tooltipTimeout) {
        if (typeof cancelIdleCallback !== 'undefined') {
            cancelIdleCallback(tooltipTimeout);
        } else {
            clearTimeout(tooltipTimeout);
        }
    }

    const doUpdate = () => {
        tooltipTimeout = null;
        const links = document.querySelectorAll('#main li a');
        for (let i = 0, len = links.length; i < len; i++) {
            const el = links[i];
            if (el.clientWidth + 1 < el.scrollWidth) {
                if (!el.title) el.title = el.textContent;
            } else if (el.title === el.textContent) {
                el.title = '';
            }
        }
    };

    // Use requestIdleCallback if available for non-blocking updates
    if (typeof requestIdleCallback !== 'undefined') {
        tooltipTimeout = requestIdleCallback(doUpdate, {timeout: 500});
    } else {
        tooltipTimeout = setTimeout(doUpdate, 100);
    }
}

// Gets children of a node (returns Promise)
async function getChildren(node, folderName) {
    if (Array.isArray(node.children)) return node.children;

    const children = await getChildren_internal(node.id);
    if (!children && coords[node.id]) {
        removeRow(coords[node.id].x, coords[node.id].y);
    }
    return children || [];
}

// gets the subtree for given id
async function getSubTree(id) {
    const specialNode = SpecialFolders.getNode(id);
    if (specialNode) return [specialNode];

    const node = await getNode_internal(id);
    if (node) {
        // Mark as folder (children will be fetched on-demand)
        node.children = true;
        return [node];
    }
    if (coords[id]) removeRow(coords[id].x, coords[id].y);
    return [];
}

// sets css classes for node - build class string directly
function setClass(target, node, isopen) {
    let className = node.className || '';
    if (node.children) className = className ? `${className} folder` : 'folder';
    if (isopen) className = className ? `${className} open` : 'open';
    if (SpecialFolders.isSpecial(node.id) || node.id === 'empty') {
        className = className ? `${className} ${node.id}` : node.id;
    }
    if (className) target.className = className;
}

// gets best icon for a node
function getIcon(node) {
    let url = null;
    let url2x = null;

    if (node.icons) {
        let size;
        // Use for-in loop for direct property iteration (no array allocation)
        for (const key in node.icons) {
            const iconInfo = node.icons[key];
            if (iconInfo.url && (!size || (iconInfo.size < size && iconInfo.size > 15))) {
                url = iconInfo.url;
                if (iconInfo.size > 31) url2x = iconInfo.url;
                size = iconInfo.size;
            }
        }
    } else if (node.icon) {
        url = node.icon;
    } else if (node.url) {
        const img = document.createElement('img');
        img.className = 'icon';
        img.alt = '';
        img.width = 16;
        img.height = 16;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = Favicon.getUrl(node.url);
        return img;
    }

    const icon = document.createElement(url ? 'img' : 'div');
    icon.className = 'icon';
    if (url) {
        icon.loading = 'lazy';
        icon.decoding = 'async';
        icon.src = url;
        if (url2x) icon.srcset = `${url2x} 2x`;
        icon.alt = '';
    }
    return icon;
}

// toggle folder open state
async function toggle(node, a) {
    const isopen = a.open;
    setClass(a, node, !isopen);
    a.open = !isopen;

    const openKey = `open.${node.id}`;
    const autoClose = getConfig('auto_close');
    if (isopen) {
        localStorage.removeItem(openKey);
        if (a.nextSibling) {
            if (autoClose) {
                const wrapper = a.nextSibling.tagName === 'DIV' ? a.nextSibling.firstChild : a.nextSibling;
                const wrapperChildren = wrapper.children;
                for (let i = 0, len = wrapperChildren.length; i < len; i++) {
                    const child = wrapperChildren[i].firstChild;
                    if (child?.open) child.onclick();
                }
            }
            animate(node, a, isopen);
        }
    } else {
        localStorage.setItem(openKey, true);
        if (autoClose) {
            const siblings = a.parentNode.parentNode.children;
            for (let i = 0, len = siblings.length; i < len; i++) {
                const sibling = siblings[i].firstChild;
                if (sibling !== a && sibling?.open) sibling.onclick();
            }
        }
        if (a.nextSibling) {
            animate(node, a, isopen);
        } else {
            const result = await getChildren(node);
            if (!a.nextSibling && a.open) {
                renderAll(result, a.parentNode);
                animate(node, a, isopen);
            }
        }
    }
}

// smoothly open or close folder
function animate(node, a, isopen) {
    // wrapper needed for inner height value
    let wrap = a.nextSibling;
    const inner = wrap.firstChild;
    const wrapStyle = wrap.style;
    if (a.animationHandle) {
        clearTimeout(a.animationHandle);
        a.animationHandle = null;
    } else {
        wrapStyle.height = isopen ? `${inner.clientHeight}px` : '0';
        wrapStyle.opacity = isopen ? '1' : '0';
    }
    // requestAnimationFrame twice to ensure at least one frame has passed
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (wrap) {
                wrap.className = 'wrap';
                wrapStyle.height = isopen ? '0' : `${inner.clientHeight}px`;
                wrapStyle.opacity = isopen ? '0' : '1';
                wrapStyle.pointerEvents = isopen ? 'none' : '';
            }
        });
    });

    const duration = scale(getConfig('slide'), 0.2, 1) * 1000;
    a.animationHandle = setTimeout(() => {
        a.animationHandle = null;
        if (isopen) {
            wrap.remove();
        } else {
            wrap.className = '';
            wrap.removeAttribute('style');
        }
        wrap = null;
    }, duration);
}

// opens immediate children of given node in new tabs
async function openLinks(node) {
    const result = await getChildren(node);
    for (let i = 0, len = result.length; i < len; i++) {
        openLink(result[i], TAB_OPEN_MODE.BACKGROUND);
    }
}

// opens given node
// mode: TAB.CURRENT, TAB.FOREGROUND, or TAB.BACKGROUND
function openLink(node, mode) {
    const {url} = node;
    if (!url) return;
    if (mode === TAB_OPEN_MODE.BACKGROUND) {
        chrome.tabs.create({url, active: false});
        return;
    }
    if (mode === TAB_OPEN_MODE.FOREGROUND) {
        chrome.tabs.create({url, active: true});
        return;
    }
    window.location.href = url;
}

let columns; // columns[x][y] = id
let root;    // root[] = id
let rootSet; // Set for O(1) root lookups
let coords;  // coords[id] = {x, y}

// ensure root folders are included
function verifyColumns() {
    // default layout
    if (columns.length === 0) {
        columns.push([]);
        const defaultColumn = [];
        for (let i = 0, len = special.length; i < len; i++) {
            const a = special[i];
            if (getConfig(`show_${a}`)) defaultColumn.push(a);
        }
        columns.push(defaultColumn);
    }

    // find missing root items - build existing set with nested loops (faster than flat())
    const existing = new Set();
    for (let x = 0, xLen = columns.length; x < xLen; x++) {
        const col = columns[x];
        for (let y = 0, yLen = col.length; y < yLen; y++) {
            existing.add(col[y]);
        }
    }
    const missing = [];
    for (let i = 0, len = root.length; i < len; i++) {
        const id = root[i];
        if (!existing.has(id)) missing.push(id);
    }

    for (let i = 0, len = missing.length; i < len; i++) {
        const id = missing[i];
        if (getConfig(`show_${id}`)) {
            columns[0].push(id);
        }
    }

    // populate coordinate map and remove empty columns
    coords = {};
    for (let x = columns.length - 1; x >= 0; x--) {
        if (columns[x].length === 0) {
            columns.splice(x, 1);
        } else {
            const col = columns[x];
            for (let y = 0, len = col.length; y < len; y++) {
                coords[col[y]] = {x, y};
            }
        }
    }
}

// Show error message when cache is unavailable
function showCacheError(error) {
    const main = getMainElement();
    main.replaceChildren(); // Modern way to clear children

    const errorDiv = document.createElement('div');
    errorDiv.className = 'cache-error';
    errorDiv.innerHTML = `
        <h2>⚠️ Could not load bookmarks</h2>
        <p>The bookmark cache is not available. This usually means:</p>
        <ul>
            <li>The extension was just installed (wait a moment and refresh)</li>
            <li>The service worker hasn't synced yet</li>
            <li>There was an error syncing bookmarks</li>
        </ul>
        <p>Check the console for more details.</p>
    `;
    main.append(errorDiv);

    console.error('[BookmarkCache] Cache unavailable:', error);
    console.error('[BookmarkCache] Cache status:', cacheStatus);
    console.error('[BookmarkCache] To debug: Open chrome://extensions, find this extension, and check the service worker logs');
}

// load columns from storage or default
async function loadColumns() {
    // Load ALL data into memory cache FIRST (single IndexedDB read)
    // This is faster than checking status first (which would be 2 separate reads)
    // After this, getCacheStatus() will use the in-memory cache (instant)
    try {
        await BookmarkCache.loadAllData();
    } catch (e) {
        console.error('[BookmarkCache] loadAllData failed:', e);
        showCacheError(e);
        return;
    }

    // Check if bookmark cache is valid (uses in-memory cache now - instant)
    const status = await checkCacheStatus();
    if (!status.valid) {
        console.error('[BookmarkCache] Cache not valid:', status);
        showCacheError(cacheLoadError || new Error('Cache not initialized'));
        return;
    }

    columns = [];
    forEachColumnEntry((x, y, id) => {
        if (!columns[x]) columns[x] = [];
        columns[x][y] = id;
    });

    if (root) {
        verifyColumns();
        await renderColumns();
    } else {
        const rootIds = await getRootFolderIds();
        // Build root array without concat (avoid intermediate array)
        const specialLen = special.length;
        const rootIdsLen = rootIds.length;
        root = new Array(specialLen + rootIdsLen);
        for (let i = 0; i < specialLen; i++) root[i] = special[i];
        for (let i = 0; i < rootIdsLen; i++) root[specialLen + i] = rootIds[i];
        // Build Set for O(1) lookups
        rootSet = new Set(root);
        verifyColumns();
        await renderColumns();
    }

    // After first paint, expand deferred special folders (slow Chrome API calls)
    if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(() => {
            requestAnimationFrame(async () => {
                await expandDeferredFolders();
            });
        });
    }
}

// saves current column configuration to storage
function saveColumns() {
    // clear previous config
    forEachColumnEntry((x, y) => localStorage.removeItem(`column.${x}.${y}`));
    verifyColumns();
    // save new config
    for (let x = 0, xLen = columns.length; x < xLen; x++) {
        const col = columns[x];
        for (let y = 0, yLen = col.length; y < yLen; y++) {
            localStorage.setItem(`column.${x}.${y}`, col[y]);
        }
    }
    loadColumns();
}

// removes ids from columns, returns adjusted {xpos, ypos} if provided
function removeIdsFromColumns(ids, xpos, ypos) {
    // Use Set for O(1) lookup instead of O(n) array includes
    const idSet = new Set(ids);
    for (let x = 0; x < columns.length; x++) {
        for (let y = columns[x].length - 1; y >= 0; y--) {
            if (idSet.has(columns[x][y])) {
                columns[x].splice(y, 1);
                if (xpos !== undefined && x === xpos && ypos > y) ypos--;
            }
        }
        if (columns[x].length === 0) {
            columns.splice(x, 1);
            if (xpos !== undefined && xpos > x) xpos--;
            x--;
        }
    }
    return {xpos, ypos};
}

// creates and saves a new column
function addColumn(ids, index) {
    removeIdsFromColumns(ids);
    const insertAt = Math.min(index ?? columns.length, columns.length);
    columns.splice(insertAt, 0, [...ids]);
    saveColumns();
}

// removes given column
function removeColumn(index) {
    columns.splice(index, 1);
    saveColumns();
}

// creates and saves a new row
function addRow(id, xpos, ypos) {
    ypos = ypos ?? columns[xpos].length;
    const adjusted = removeIdsFromColumns([id], xpos, ypos);
    const insertAt = Math.min(adjusted.ypos, columns[adjusted.xpos].length);
    columns[adjusted.xpos].splice(insertAt, 0, id);
    saveColumns();
}

// removes given row
function removeRow(xpos, ypos) {
    columns[xpos].splice(ypos, 1);
    saveColumns();
}

// refresh recently closed tab lists
function refreshClosed() {
    const targets = [];
    const folders = document.getElementsByClassName('closed');

    for (let i = 0, len = folders.length; i < len; i++) {
        const a = folders[i];
        if (a.nextSibling) {
            a.nextSibling.remove();
            targets.push(a.parentNode);
        }
    }

    if (folders.length === 0 && coords.closed) {
        const target = document.getElementsByClassName('column')[coords.closed.x];
        target.firstChild.remove();
        targets.push(target);
    }

    getChildren({id: 'closed'}).then(result => {
        for (let i = 0, len = targets.length; i < len; i++) {
            renderAll(result, targets[i]);
        }
    });
}

// options : default values
const config = {
    font: 'Sans-serif',
    font_size: 16,
    font_weight: 400,
    theme: 'Default',
    font_color: '#555555',
    background_color: '#ffffff',
    highlight_color: '#e4f4ff',
    highlight_font_color: '#000000',
    shadow_color: '#57b0ff',
    background_image_file: '',
    background_image: '',
    background_align: 'left top',
    background_repeat: 'repeat',
    background_size: 'auto',
    shadow_blur: 1,
    highlight_round: 1,
    fade: 1,
    spacing: 1,
    width: 1,
    h_pos: 1,
    v_margin: 1,
    slide: 1,
    hide_options: 0,
    lock: 0,
    show_top: 1,
    show_recent: 1,
    show_closed: 1,
    show_devices: 1,
    show_root: 1,
    newtab: 0,
    remember_open: 1,
    auto_close: 0,
    auto_scale: 1,
    css: '',
    number_top: 10,
    number_closed: 10,
    number_recent: 10,
    favicon_provider: 'duckduckgo'
};

// themes is defined in themes.js (loaded before this script)
let theme = {};

// Config value cache - avoids repeated localStorage reads during rendering
const configCache = new Map();

function getConfig(key) {
    // Use single get() call instead of has() + get() to avoid double lookup
    const cached = configCache.get(key);
    if (cached !== undefined) return cached;

    const value = localStorage.getItem(`options.${key}`);
    let result;
    if (value != null) {
        // Dynamic show_* keys (e.g., show_2, show_4) are numbers but not in config
        const isShowKey = key.startsWith('show_');
        const isNumber = typeof config[key] === 'number' || (isShowKey && !(key in config));
        result = isNumber ? Number(value) : value;
    } else {
        result = key in theme ? theme[key] : config[key];
    }
    configCache.set(key, result);
    return result;
}

// set config value
function setConfig(key, value) {
    // Invalidate cache for this key
    configCache.delete(key);

    const storageKey = `options.${key}`;
    if (value != null) {
        localStorage.setItem(storageKey, typeof config[key] === 'number' ? Number(value) : value);
    } else {
        localStorage.removeItem(storageKey);
        value = key in theme ? theme[key] : config[key];
    }

    // special case settings
    if (key === 'lock' || key === 'newtab' || key === 'show_root' || key.startsWith('number')) {
        loadColumns();
    } else if (key === 'theme') {
        theme = themes[value];
        configCache.clear(); // Theme affects all config defaults
        const configKeys = Object.keys(config);
        for (let i = 0, len = configKeys.length; i < len; i++) {
            const k = configKeys[i];
            if (k !== key) {
                onChange(k);
                showConfig(k);
            }
        }
    } else if (key.startsWith('show')) {
        const id = key.slice(5);
        if (!value && coords[id]) {
            removeRow(coords[id].x, coords[id].y);
        }
        saveColumns();
    }

    onChange(key, value);
    return value;
}

// map config keys to styles
const styles = {};

// Style schema: maps config keys to CSS generation functions
// Each function takes a value and returns a CSS string (or null to skip)
const styleSchema = {
    font: v => `#main a { font-family: "${v}"; }`,
    font_size: v => `#main a { font-size: ${v / 10}em; }`,
    font_weight: v => `#main a { font-weight: ${v}; }`,
    font_color: v => `#main a { color: ${v}; }`,
    background_color: v => `body { background-color: ${v}; }`,
    background_image: v => `body { background-image: url(${v}); }`,
    background_image_file: v => `body { background-image: url(${v}); }`,
    background_align: v => `body { background-position: ${v}; }`,
    background_repeat: v => `body { background-repeat: ${v}; }`,
    background_size: v => `body { background-size: ${v}; }`,
    highlight_font_color: v => `#main a:hover { color: ${v}; }`,
    highlight_color: v => `#main a:hover { background-color: ${v}; }`,
    shadow_color: v => `#main a:hover { box-shadow: 0 0 ${scale(getConfig('shadow_blur'), 7, 100)}px ${v}; }`,
    shadow_blur: v => `#main a:hover { box-shadow: 0 0 ${scale(v, 7, 100)}px ${getConfig('shadow_color')}; }`,
    highlight_round: v => `#main a { border-radius: ${scale(v, 0.2, 1.5)}em; }`,
    fade: v => `#main a { transition-duration: ${scale(v, 0.2, 1)}s; }`,
    slide: v => `.wrap { transition-duration: ${scale(v, 0.2, 1)}s; }`,
    spacing: v => `#main a { line-height: ${scale(v, 2, 5.6, 0.8)}; padding-left: ${scale(v, 0.8, 2, 0.4)}em; padding-right: ${scale(v, 0.8, 2, 0.4)}em; }`,
    width: v => `#main { width: ${getConfig('auto_scale') ? `${scale(v, 80, 100, 20)}%` : `${scale(v, 1000, 3000, 400)}px`}; }`,
    h_pos: v => {
        const margin = 100 - scale(getConfig('width'), 80, 100, 20);
        return `#main { left: ${scale(v, 0, margin / 2, -margin / 2)}%; }`;
    },
    v_margin: v => `#main { margin-top: ${getConfig('auto_scale') ? `${scale(v, 5, 20)}%` : `${scale(v, 80, 600)}px`}; }`,
    hide_options: () => '#options_button { opacity: 0; }',
    css: v => v,
    auto_scale: v => v ? null : '#main { margin-top: 80px; width: 1000px; }'
};

function getStyle(key, value) {
    const fn = styleSchema[key];
    return fn ? fn(value) : null;
}

// scales input value from [0,1,2] to [min,mid,max]
function scale(value, mid, max, min = 0) {
    return value > 1
        ? mid + (value - 1) * (max - mid)
        : min + value * (mid - min);
}

// apply config value change
function onChange(key, value) {
    value = value ?? getConfig(key);

    if (value !== config[key]) {
        const css = getStyle(key, value);
        if (css) {
            const style = styles[key] ?? (styles[key] = document.createElement('style'));
            document.head.appendChild(style);
            style.textContent = css;
        }
    } else if (key in styles) {
        styles[key].remove();
        delete styles[key];
    }

    // refresh dependent values
    if (key === 'width') onChange('h_pos');
    else if (key === 'shadow_blur') onChange('shadow_color');
    else if (key === 'auto_scale') {
        onChange('width');
        onChange('v_margin');
    }

    if (!settingsInitialized) return;

    // show/hide default button
    const input = document.getElementById(`options_${key}`);
    if (input) {
        const isDefault = value === (key in theme ? theme[key] : config[key]);
        input.reset.style.visibility = isDefault ? 'hidden' : null;
        if (input.swatch) input.swatch.value = value;
    }
}

// loads config settings
function loadSettings() {
    // Remove prevent-white-flash.js overrides so new settings can take effect
    document.getElementById('early-styles')?.remove();
    theme = themes[getConfig('theme')] ?? {};
    const configKeys = Object.keys(config);
    for (let i = 0, len = configKeys.length; i < len; i++) {
        const key = configKeys[i];
        if (key === 'background_image_file') {
            setTimeout(() => onChange('background_image_file'), 0);
        } else {
            onChange(key);
        }
    }
}

// apply config values to input controls
function showConfig(key) {
    const input = document.getElementById(`options_${key}`);
    if (!input || input.type === 'file') return;
    input[input.type === 'checkbox' ? 'checked' : 'value'] = getConfig(key);
}

// initialize config settings
function initConfig(key) {
    const input = document.getElementById(`options_${key}`);
    if (!input) return;

    if (input.type === 'color') {
        input.type = 'text';
        input.className = 'color';
        const swatch = document.createElement('input');
        swatch.type = 'color';
        swatch.value = input.value;
        swatch.oninput = e => {
            input.value = swatch.value;
            return input.onchange(e);
        };
        input.swatch = swatch;
        input.parentNode.appendChild(swatch);
    }

    input.onchange = e => {
        if (input.type === 'file') {
            if (e.target.files.length === 1) {
                const file = e.target.files[0];
                if (file.size > 2097152) {
                    input.value = null;
                    alert('Image must be less than 2 MB.');
                    return false;
                }
                const reader = new FileReader();
                reader.onload = f => {
                    if (f.target.result) setConfig(key, f.target.result);
                };
                reader.readAsDataURL(file);
            }
        } else {
            setConfig(key, input.type === 'checkbox' ? Number(input.checked) : input.value);
        }
    };

    const reset = document.createElement('a');
    reset.className = 'revert';
    reset.title = 'Reset to default';
    reset.tabIndex = 0;
    reset.onclick = () => {
        setConfig(key, null);
        showConfig(key);
        return false;
    };

    input.reset = reset;
    input.parentNode.appendChild(reset);
    showConfig(key);
}

let settingsInitialized = false;

// initialize options panel
function initSettings() {
    settingsInitialized = true;

    document.getElementById('options_close_button').onclick = () => {
        showOptions(false);
        return false;
    };

    const options = document.getElementById('options');
    const nav = document.getElementById('options_nav');
    let currentIndex = 0;

    const sections = Array.from(options.getElementsByClassName('section'));
    const navChildren = Array.from(nav.children);
    for (let i = 0, len = navChildren.length; i < len; i++) {
        const a = navChildren[i].firstChild;
        a.onclick = function () {
            // clear current style
            navChildren[currentIndex].firstChild.classList.remove('current');
            sections[currentIndex].classList.remove('current');

            // apply new current style
            currentIndex = i;
            navChildren[currentIndex].firstChild.classList.add('current');
            sections[currentIndex].classList.add('current');

            // show custom css on advanced tab
            if (currentIndex === len - 1) {
                const allcss = document.getElementById('all_css');
                const configKeys = Object.keys(config);
                const cssLines = [];
                for (let j = 0, kLen = configKeys.length; j < kLen; j++) {
                    const css = getStyle(configKeys[j], getConfig(configKeys[j]));
                    if (css && css.length < 1000) cssLines.push(css);
                }
                allcss.value = cssLines.join('\n');
            }

            // import/export
            if (currentIndex === len - 2) {
                const exports = document.getElementById('options_export');
                const imports = document.getElementById('options_import');
                const replacer = (k, v) =>
                    (k === 'options.background_image_file' || k.startsWith('cache.')) ? undefined : v;

                exports.value = JSON.stringify(localStorage, replacer);
                imports.value = '';
                imports.placeholder = 'Paste exported settings here';
                imports.onchange = () => {
                    try {
                        const imported = JSON.parse(imports.value);
                        localStorage.clear();
                        const entries = Object.entries(imported);
                        for (let i = 0, len = entries.length; i < len; i++) {
                            const [k, v] = entries[i];
                            localStorage.setItem(k, v);
                        }
                        imports.value = '';
                        imports.placeholder = 'Import successful!';
                        exports.value = JSON.stringify(localStorage, replacer);
                        loadSettings();
                        loadColumns();
                        const configKeys = Object.keys(config);
                        for (let i = 0, len = configKeys.length; i < len; i++) {
                            showConfig(configKeys[i]);
                        }
                    } catch {
                        imports.value = '';
                        imports.placeholder = 'Import error! Please check if your settings are valid JSON.';
                    }
                };
            }
            return false;
        };
    }

    // add options to hide bookmark folders (load from cache)
    BookmarkCache.getFolder('0').then(async rootFolder => {
        const placeholder = document.getElementById('options_show_bookmarks');
        const children = rootFolder?.children || [];
        for (let i = 0, len = children.length; i < len; i++) {
            const node = children[i];
            if (!node.isFolder) continue;

            const key = `show_${node.id}`;
            config[key] = 1;

            const span = document.createElement('span');
            span.textContent = node.title;

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.id = `options_${key}`;

            const label = document.createElement('label');
            label.append(span, input); // append multiple elements at once
            placeholder.append(label);
        }

        // replace text input with system font list
        if (chrome.fontSettings) {
            const fontInput = document.getElementById('options_font');
            const select = document.createElement('select');
            select.id = fontInput.id;
            fontInput.replaceWith(select); // Modern API
        }

        const configKeys = Object.keys(config);
        for (let i = 0, len = configKeys.length; i < len; i++) {
            initConfig(configKeys[i]);
        }
        loadSettings();

        // load themes
        const themeSelect = document.getElementById('options_theme');
        if (themeSelect.childNodes.length === 0) {
            const themeNames = Object.keys(themes);
            const currentTheme = getConfig('theme');
            for (let i = 0, len = themeNames.length; i < len; i++) {
                const name = themeNames[i];
                const option = document.createElement('option');
                option.textContent = name;
                option.selected = name === currentTheme;
                themeSelect.append(option);
            }
        }

        // load font list
        if (chrome.fontSettings) {
            const fonts = await chrome.fontSettings.getFontList();
            const select = document.getElementById('options_font');
            if (select.childNodes.length > 0) return;

            const currentFont = getConfig('font');
            // Add Sans-serif first
            const defaultOption = document.createElement('option');
            defaultOption.textContent = 'Sans-serif';
            defaultOption.selected = 'Sans-serif' === currentFont;
            select.append(defaultOption);
            // Add remaining fonts
            for (let i = 0, len = fonts.length; i < len; i++) {
                const fontId = fonts[i].fontId;
                const option = document.createElement('option');
                option.textContent = fontId;
                option.selected = fontId === currentFont;
                select.append(option);
            }
        }

        // Initialize Firefox favicon provider options (only show on Firefox)
        if (Favicon.isFirefox) {
            const firefoxOptions = document.getElementById('firefox_options');
            if (firefoxOptions) firefoxOptions.style.display = '';

            const providerSelect = document.getElementById('options_favicon_provider');
            if (providerSelect && providerSelect.childNodes.length === 0) {
                const providers = Favicon.getProviderList();
                const currentProvider = getConfig('favicon_provider');
                for (let i = 0, len = providers.length; i < len; i++) {
                    const p = providers[i];
                    const option = document.createElement('option');
                    option.value = p.key;
                    option.textContent = p.name;
                    option.selected = p.key === currentProvider;
                    providerSelect.append(option);
                }
            }
        }
    });
}

// show options panel
function showOptions(show) {
    document.getElementById('options').style.display = show ? 'block' : 'none';
    if (show) {
        if (!settingsInitialized) initSettings();
        const configKeys = Object.keys(config);
        for (let i = 0, len = configKeys.length; i < len; i++) {
            showConfig(configKeys[i]);
        }
    }
}

// initialize page
loadSettings();
loadColumns();

// keyboard shortcuts
document.addEventListener('keypress', e => {
    if (e.key === 'Enter' && e.target?.onclick && e.target.tagName === 'A') {
        e.target.dispatchEvent(new MouseEvent('click'));
        e.preventDefault();
    }
});

document.addEventListener('mousedown', () => document.body.classList.add('hide-focus'), {passive: true});
document.addEventListener('keydown', () => document.body.classList.remove('hide-focus'), {passive: true});

window.onresize = updateTooltips;

// load options panel
document.getElementById('options_button').onclick = () => {
    showOptions(true);
    return false;
};
if (location.search === '?options') showOptions(true);

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        TAB: TAB_OPEN_MODE,
        getColumnIds: () => {
            const ids = [];
            forEachColumnEntry((x, y, id) => ids.push(id));
            return ids;
        },
        getChildren_internal,
        special,
        expandDeferredFolders,
        render,
        renderAll,
        openLink
    };
}
