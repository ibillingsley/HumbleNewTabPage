'use strict';

(function(S) {
	S.folderFingerprint = function(node) {
		if (!node || !node.children) return null;
		var tokens = [];
		for (var i = 0; i < node.children.length; i++) {
			var child = node.children[i];
			if (child.url) tokens.push('U|' + child.url + '|' + (child.title || ''));
			else tokens.push('F|' + (child.title || ''));
		}
		tokens.sort();
		return S.hashString(tokens.join('\n'));
	};

	S.getBookmarkTree = function() {
		return new Promise(function(resolve) {
			try {
				chrome.bookmarks.getTree(function(result) {
					if (chrome.runtime && chrome.runtime.lastError) {
						console.warn('Could not read bookmarks:', chrome.runtime.lastError.message);
						resolve([]);
						return;
					}
					resolve(result || []);
				});
			} catch (error) {
				console.warn('Could not read bookmarks:', error);
				resolve([]);
			}
		});
	};

	S.buildBookmarkIndex = function(tree) {
		var index = {
			root: tree && tree[0] ? tree[0] : null,
			roots: [],
			byId: Object.create(null),
			folderEntries: [],
			rootIdToIndex: Object.create(null),
			rootIndexToId: Object.create(null)
		};
		if (!index.root) return index;
		index.roots = index.root.children || [];

		function walk(node, rootIndex, path) {
			if (!node || node.url) return;
			var entry = {
				node: node,
				rootIndex: rootIndex,
				path: path.slice(0),
				fingerprint: S.folderFingerprint(node)
			};
			index.byId[String(node.id)] = entry;
			index.folderEntries.push(entry);
			var children = node.children || [];
			var titleCounts = Object.create(null);
			for (var i = 0; i < children.length; i++) {
				var child = children[i];
				if (child.url) continue;
				var title = child.title || '';
				var occurrence = titleCounts[title] || 0;
				titleCounts[title] = occurrence + 1;
				walk(child, rootIndex, path.concat([{ title: title, occurrence: occurrence }]));
			}
		}

		for (var i = 0; i < index.roots.length; i++) {
			var root = index.roots[i];
			index.rootIdToIndex[String(root.id)] = i;
			index.rootIndexToId[String(i)] = String(root.id);
			walk(root, i, []);
		}
		return index;
	};

	S.makePortableRef = function(id) {
		id = String(id);
		if (S.SPECIAL_IDS.indexOf(id) >= 0) return { kind: 'special', id: id };
		var entry = S.bookmarkIndex && S.bookmarkIndex.byId[id];
		if (!entry) return null;
		var root = S.bookmarkIndex.roots[entry.rootIndex];
		return {
			kind: 'bookmark',
			rootIndex: entry.rootIndex,
			rootTitle: root ? (root.title || '') : '',
			path: S.clone(entry.path),
			title: entry.node.title || '',
			childCount: (entry.node.children || []).length,
			fingerprint: entry.fingerprint
		};
	};

	S.resolvePortableRef = function(ref) {
		if (!ref) return null;
		if (ref.kind === 'special' && S.SPECIAL_IDS.indexOf(ref.id) >= 0) return ref.id;
		if (ref.kind !== 'bookmark' || !S.bookmarkIndex) return null;

		var root = S.bookmarkIndex.roots[ref.rootIndex];
		if ((!root || (ref.rootTitle && (root.title || '') !== ref.rootTitle)) && ref.rootTitle) {
			for (var r = 0; r < S.bookmarkIndex.roots.length; r++) {
				if ((S.bookmarkIndex.roots[r].title || '') === ref.rootTitle) {
					root = S.bookmarkIndex.roots[r];
					break;
				}
			}
		}

		var node = root || null;
		var path = ref.path || [];
		for (var p = 0; node && p < path.length; p++) {
			var segment = path[p];
			var children = node.children || [];
			var matches = [];
			for (var c = 0; c < children.length; c++) {
				if (!children[c].url && (children[c].title || '') === segment.title)
					matches.push(children[c]);
			}
			node = matches[segment.occurrence || 0] || null;
		}
		if (node && !node.url) return String(node.id);

		// Fallback for renamed/restructured non-empty folders: compare a stable
		// fingerprint of immediate contents, then prefer the old title/root. Empty
		// folders deliberately skip this fallback so they cannot resolve to an
		// unrelated empty folder after a rename.
		var candidates = [];
		if (ref.fingerprint && Number(ref.childCount) > 0) {
			for (var i = 0; i < S.bookmarkIndex.folderEntries.length; i++) {
				var entry = S.bookmarkIndex.folderEntries[i];
				if (entry.fingerprint === ref.fingerprint)
					candidates.push(entry);
			}
		}
		if (candidates.length > 1 && ref.title) {
			var titled = candidates.filter(function(entry) {
				return (entry.node.title || '') === ref.title;
			});
			if (titled.length) candidates = titled;
		}
		if (candidates.length > 1) {
			var sameRoot = candidates.filter(function(entry) {
				return entry.rootIndex === ref.rootIndex;
			});
			if (sameRoot.length) candidates = sameRoot;
		}
		return candidates.length ? String(candidates[0].node.id) : null;
	};

	S.columnsFromValues = function(values) {
		var result = [];
		for (var x = 0; ; x++) {
			var row = [];
			for (var y = 0; ; y++) {
				var value = values['column.' + x + '.' + y];
				if (value != null && value !== '') row.push(String(value));
				else break;
			}
			if (row.length) result.push(row);
			else break;
		}
		return result;
	};

	S.portableLayoutFromColumns = function(columns) {
		var portable = [];
		for (var x = 0; x < columns.length; x++) {
			var row = [];
			for (var y = 0; y < columns[x].length; y++) {
				var ref = S.makePortableRef(columns[x][y]);
				if (ref) row.push(ref);
			}
			if (row.length) portable.push(row);
		}
		return portable;
	};

	S.resolvePortableLayout = function(columns) {
		var resolved = [];
		columns = columns || [];
		for (var x = 0; x < columns.length; x++) {
			var row = [];
			for (var y = 0; y < columns[x].length; y++) {
				var id = S.resolvePortableRef(columns[x][y]);
				if (id) row.push(id);
			}
			if (row.length) resolved.push(row);
		}
		return resolved;
	};

	S.layoutHash = function(columns) {
		return S.hashString(JSON.stringify(columns || []));
	};
})(HumbleSync);
