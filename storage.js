'use strict';

// Shared state and compatibility facade for Humble's storage/sync modules.
var HumbleSync = (function() {
	var S = {};
	S.SCHEMA_VERSION = 2;
	S.PREFIX = 'hntp.';
	S.LOCAL_VALUES_KEY = S.PREFIX + 'localValues';
	S.LOCAL_META_KEY = S.PREFIX + 'meta';
	S.SYNC_SCHEMA_KEY = S.PREFIX + 'schema';
	S.OPTION_PREFIX = S.PREFIX + 'option.';
	S.ROOT_VISIBILITY_PREFIX = S.PREFIX + 'rootVisibility.';
	S.LAYOUT_PREFIX = S.PREFIX + 'layout.';
	S.SPECIAL_IDS = ['apps', 'top', 'recent', 'closed', 'devices'];
	S.MAX_LAYOUT_BACKUPS = 10;
	S.PORTABLE_EXPORT_KEY = '__hntp_portable_layout_v2';
	S.LAYOUT_SAVE_DELAY = 700;
	S.REMOTE_REFRESH_DELAY = 250;

	S.legacyStorage = window.localStorage;
	S.storagePrototype = Object.getPrototypeOf(S.legacyStorage);
	S.originalGetItem = S.storagePrototype.getItem;
	S.originalSetItem = S.storagePrototype.setItem;
	S.originalRemoveItem = S.storagePrototype.removeItem;
	S.originalKey = S.storagePrototype.key;
	S.originalClear = S.storagePrototype.clear;
	S.originalToJSON = S.storagePrototype.toJSON;

	S.localArea = chrome.storage && chrome.storage.local;
	S.syncArea = chrome.storage && chrome.storage.sync;
	S.cache = Object.create(null);
	S.localValues = Object.create(null);
	S.meta = {
		deviceId: null,
		migrationVersion: 0,
		optionShadow: {},
		layoutBackups: [],
		lastAppliedLayout: null,
		lastSyncAt: null,
		conflictCount: 0
	};
	S.bookmarkIndex = null;
	S.adapterInstalled = false;
	S.initialized = false;
	S.initializing = true;
	S.layoutDirty = false;
	S.layoutSaveTimer = null;
	S.remoteRefreshTimer = null;
	S.localPersistTimer = null;
	S.reloadTimer = null;
	S.syncAvailable = !!S.syncArea;
	S.initError = null;

	S.now = function() { return Date.now(); };
	S.clone = function(value) {
		return value == null ? value : JSON.parse(JSON.stringify(value));
	};
	S.generateDeviceId = function() {
		if (window.crypto && typeof window.crypto.randomUUID === 'function')
			return window.crypto.randomUUID();
		return 'device-' + S.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
	};

	S.storageGet = function(area, keys) {
		return new Promise(function(resolve) {
			if (!area) { resolve({}); return; }
			try {
				area.get(keys, function(result) {
					if (chrome.runtime && chrome.runtime.lastError) {
						var message = chrome.runtime.lastError.message;
						console.warn('Humble storage get failed:', message);
						if (S.noteStorageError) S.noteStorageError('get', area === S.syncArea ? 'sync' : 'local', message);
						resolve({});
						return;
					}
					var data = result || {};
					if (S.noteStorageSuccess) S.noteStorageSuccess('get', area === S.syncArea ? 'sync' : 'local', data);
					resolve(data);
				});
			} catch (error) {
				console.warn('Humble storage get failed:', error);
				if (S.noteStorageError) S.noteStorageError('get', area === S.syncArea ? 'sync' : 'local', error.message || error);
				resolve({});
			}
		});
	};
	S.storageSet = function(area, values) {
		return new Promise(function(resolve) {
			if (!area || !values || Object.keys(values).length === 0) { resolve(false); return; }
			try {
				area.set(values, function() {
					if (chrome.runtime && chrome.runtime.lastError) {
						var message = chrome.runtime.lastError.message;
						console.warn('Humble storage set failed:', message);
						if (S.noteStorageError) S.noteStorageError('set', area === S.syncArea ? 'sync' : 'local', message);
						resolve(false);
						return;
					}
					if (S.noteStorageSuccess) S.noteStorageSuccess('set', area === S.syncArea ? 'sync' : 'local', values);
					resolve(true);
				});
			} catch (error) {
				console.warn('Humble storage set failed:', error);
				if (S.noteStorageError) S.noteStorageError('set', area === S.syncArea ? 'sync' : 'local', error.message || error);
				resolve(false);
			}
		});
	};

	S.snapshotLegacyStorage = function() {
		var result = Object.create(null);
		for (var i = 0; i < S.legacyStorage.length; i++) {
			var key = S.originalKey.call(S.legacyStorage, i);
			if (key != null)
				result[key] = S.originalGetItem.call(S.legacyStorage, key);
		}
		return result;
	};
	S.isColumnKey = function(key) { return /^column\.\d+\.\d+$/.test(key); };
	S.isOptionKey = function(key) { return key.indexOf('options.') === 0; };
	S.isLocalOnlyOption = function(key) { return key === 'options.background_image_file'; };
	S.numericRootOptionId = function(key) {
		var match = /^options\.show_(\d+)$/.exec(key);
		return match ? match[1] : null;
	};
	S.hashString = function(text) {
		var hash = 2166136261;
		for (var i = 0; i < text.length; i++) {
			hash ^= text.charCodeAt(i);
			hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
		}
		return ('00000000' + (hash >>> 0).toString(16)).slice(-8);
	};
	S.compareVersioned = function(a, b) {
		if (!a && !b) return 0;
		if (!a) return -1;
		if (!b) return 1;
		var at = Number(a.updatedAt) || 0, bt = Number(b.updatedAt) || 0;
		if (at !== bt) return at > bt ? 1 : -1;
		var ar = Number(a.revision) || 0, br = Number(b.revision) || 0;
		if (ar !== br) return ar > br ? 1 : -1;
		var ad = String(a.updatedBy || ''), bd = String(b.updatedBy || '');
		return ad === bd ? 0 : (ad > bd ? 1 : -1);
	};

	S.syncKeyForLocalOption = function(localKey) {
		var rootId = S.numericRootOptionId(localKey);
		if (rootId != null) {
			var rootIndex = S.bookmarkIndex && S.bookmarkIndex.rootIdToIndex[rootId];
			return rootIndex != null ? S.ROOT_VISIBILITY_PREFIX + rootIndex : null;
		}
		if (S.isOptionKey(localKey) && !S.isLocalOnlyOption(localKey))
			return S.OPTION_PREFIX + localKey.substring('options.'.length);
		return null;
	};
	S.isSyncableOption = function(key) {
		return S.isOptionKey(key) && !S.isLocalOnlyOption(key) && S.syncKeyForLocalOption(key) != null;
	};
	S.localOptionKeyForSyncKey = function(syncKey) {
		if (syncKey.indexOf(S.OPTION_PREFIX) === 0)
			return 'options.' + syncKey.substring(S.OPTION_PREFIX.length);
		if (syncKey.indexOf(S.ROOT_VISIBILITY_PREFIX) === 0) {
			var rootIndex = syncKey.substring(S.ROOT_VISIBILITY_PREFIX.length);
			var rootId = S.bookmarkIndex && S.bookmarkIndex.rootIndexToId[rootIndex];
			return rootId != null ? 'options.show_' + rootId : null;
		}
		return null;
	};
	S.makeEnvelope = function(value, deleted, previous) {
		return {
			v: S.SCHEMA_VERSION,
			value: deleted ? null : value,
			deleted: !!deleted,
			revision: (previous && Number(previous.revision) || 0) + 1,
			updatedAt: S.now(),
			updatedBy: S.meta.deviceId
		};
	};

	S.mirrorSet = function(key, value) {
		S.cache[key] = String(value);
		S.originalSetItem.call(S.legacyStorage, key, String(value));
	};
	S.mirrorRemove = function(key) {
		delete S.cache[key];
		S.originalRemoveItem.call(S.legacyStorage, key);
	};
	S.rebuildMirror = function() {
		S.originalClear.call(S.legacyStorage);
		Object.keys(S.cache).forEach(function(key) {
			S.originalSetItem.call(S.legacyStorage, key, String(S.cache[key]));
		});
	};
	S.setResolvedColumns = function(columns) {
		Object.keys(S.cache).forEach(function(key) {
			if (S.isColumnKey(key)) delete S.cache[key];
		});
		for (var x = 0; x < columns.length; x++)
			for (var y = 0; y < columns[x].length; y++)
				S.cache['column.' + x + '.' + y] = String(columns[x][y]);
		S.rebuildMirror();
	};

	S.persistLocalSoon = function() {
		if (!S.localArea) return;
		if (S.localPersistTimer) clearTimeout(S.localPersistTimer);
		S.localPersistTimer = setTimeout(function() {
			S.localPersistTimer = null;
			var values = {};
			values[S.LOCAL_VALUES_KEY] = S.clone(S.localValues);
			values[S.LOCAL_META_KEY] = S.clone(S.meta);
			S.storageSet(S.localArea, values);
		}, 150);
	};

	S.getItem = function(key) {
		return Object.prototype.hasOwnProperty.call(S.cache, key) ? S.cache[key] : null;
	};
	S.setItem = function(key, value) {
		value = String(value);
		if (key === S.PORTABLE_EXPORT_KEY) {
			if (S.importPortableLayout) S.importPortableLayout(value);
			return;
		}
		S.mirrorSet(key, value);
		if (S.initializing) return;
		if (S.isColumnKey(key)) { S.scheduleLayoutSave(); return; }
		if (S.isSyncableOption(key)) { S.writeSyncOption(key, value, false); return; }
		S.localValues[key] = value;
		S.persistLocalSoon();
	};
	S.removeItem = function(key) {
		S.mirrorRemove(key);
		if (S.initializing) return;
		if (S.isColumnKey(key)) { S.scheduleLayoutSave(); return; }
		if (S.isSyncableOption(key)) { S.writeSyncOption(key, null, true); return; }
		delete S.localValues[key];
		S.persistLocalSoon();
	};

	S.exportObject = function() {
		var result = {};
		Object.keys(S.cache).forEach(function(key) {
			if (!S.isColumnKey(key)) result[key] = S.cache[key];
		});
		if (S.currentPortableLayout) {
			var portable = S.currentPortableLayout();
			if (portable.columns.length)
				result[S.PORTABLE_EXPORT_KEY] = JSON.stringify({ v: S.SCHEMA_VERSION, columns: portable.columns });
		}
		return result;
	};

	S.installLegacyAdapter = function() {
		if (S.adapterInstalled) return;
		try {
			S.storagePrototype.getItem = function(key) {
				return this === S.legacyStorage ? S.getItem(String(key)) : S.originalGetItem.call(this, key);
			};
			S.storagePrototype.setItem = function(key, value) {
				return this === S.legacyStorage ? S.setItem(String(key), value) : S.originalSetItem.call(this, key, value);
			};
			S.storagePrototype.removeItem = function(key) {
				return this === S.legacyStorage ? S.removeItem(String(key)) : S.originalRemoveItem.call(this, key);
			};
			S.storagePrototype.toJSON = function() {
				if (this === S.legacyStorage) return S.exportObject();
				if (typeof S.originalToJSON === 'function') return S.originalToJSON.call(this);
				var result = {};
				for (var i = 0; i < this.length; i++) {
					var key = S.originalKey.call(this, i);
					result[key] = S.originalGetItem.call(this, key);
				}
				return result;
			};
			S.adapterInstalled = true;
		} catch (error) {
			console.error('Could not install Humble localStorage compatibility adapter:', error);
			S.adapterInstalled = false;
		}
	};

	S.debugInfo = function() {
		return {
			backend: S.initialized ? 'chrome.storage.local + chrome.storage.sync' : 'Initializing...',
			syncEnabled: S.syncAvailable && !!S.syncArea,
			schemaVersion: S.SCHEMA_VERSION,
			deviceId: S.meta.deviceId || 'Pending',
			layoutRevision: S.meta.lastAppliedLayout ? (S.meta.lastAppliedLayout.revision || 0) : 0,
			lastSyncAt: S.meta.lastSyncAt,
			backupCount: (S.meta.layoutBackups || []).length,
			conflictCount: Number(S.meta.conflictCount) || 0,
			adapterInstalled: S.adapterInstalled,
			initError: S.initError
		};
	};
	S.formatTimestamp = function(timestamp) {
		if (!timestamp) return 'Never';
		try { return new Date(timestamp).toLocaleString(); }
		catch (error) { return String(timestamp); }
	};
	S.updateDevelopmentInfo = function() {
		var info = S.debugInfo();
		var fields = {
			dev_storage_backend: info.backend,
			dev_sync_status: info.syncEnabled ? 'Enabled' : (info.initError ? 'Fallback / unavailable' : 'Unavailable'),
			dev_device_id: info.deviceId,
			dev_layout_revision: String(info.layoutRevision),
			dev_last_sync: S.formatTimestamp(info.lastSyncAt),
			dev_backup_status: String(info.backupCount),
			dev_conflicts: String(info.conflictCount)
		};
		Object.keys(fields).forEach(function(id) {
			var element = document.getElementById(id);
			if (element) element.value = fields[id];
		});
		var restore = document.getElementById('dev_restore_layout');
		if (restore) restore.disabled = info.backupCount === 0;
	};
	S.attachDevelopmentControls = function() {
		var restore = document.getElementById('dev_restore_layout');
		if (restore && !restore.dataset.bound) {
			restore.dataset.bound = '1';
			restore.onclick = function() {
				restore.disabled = true;
				S.restoreLastLayoutBackup().then(function(ok) {
					if (!ok) { restore.disabled = false; S.updateDevelopmentInfo(); }
				});
				return false;
			};
		}
		S.updateDevelopmentInfo();
	};

	return S;
})();
