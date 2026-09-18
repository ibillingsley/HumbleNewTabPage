'use strict';

(function(S) {
	S.initialSettingsAndMigration = function(legacySnapshot, localData, syncData) {
		S.localValues = S.clone(localData[S.LOCAL_VALUES_KEY] || {}) || {};
		var storedMeta = localData[S.LOCAL_META_KEY] || {};
		S.meta = Object.assign(S.meta, storedMeta);
		S.meta.optionShadow = S.meta.optionShadow || {};
		S.meta.layoutBackups = S.meta.layoutBackups || [];
		S.meta.deviceId = S.meta.deviceId || S.generateDeviceId();

		Object.keys(S.localValues).forEach(function(key) {
			if (S.isSyncableOption(key)) delete S.localValues[key];
		});

		var migrating = Number(S.meta.migrationVersion || 0) < S.SCHEMA_VERSION;
		var syncWrites = {};

		// Keep local-only and unknown legacy values. Syncable options are handled
		// separately so remote values can win cleanly during first migration.
		Object.keys(legacySnapshot).forEach(function(key) {
			if (S.isColumnKey(key) || S.isSyncableOption(key)) return;
			if (!Object.prototype.hasOwnProperty.call(S.localValues, key))
				S.localValues[key] = legacySnapshot[key];
		});

		Object.keys(legacySnapshot).forEach(function(localKey) {
			if (!S.isSyncableOption(localKey)) return;
			var syncKey = S.syncKeyForLocalOption(localKey);
			if (!syncKey) return;
			var remote = syncData[syncKey];
			if (remote) {
				var shadow = S.meta.optionShadow[syncKey];
				if (shadow && S.compareVersioned(shadow, remote) > 0)
					syncWrites[syncKey] = S.clone(shadow);
				else
					S.meta.optionShadow[syncKey] = S.clone(remote);
				return;
			}
			if (migrating) {
				var envelope = S.makeEnvelope(legacySnapshot[localKey], false, S.meta.optionShadow[syncKey]);
				S.meta.optionShadow[syncKey] = S.clone(envelope);
				syncWrites[syncKey] = envelope;
			}
		});

		Object.keys(syncData).forEach(function(syncKey) {
			if (syncKey.indexOf(S.OPTION_PREFIX) !== 0 && syncKey.indexOf(S.ROOT_VISIBILITY_PREFIX) !== 0)
				return;
			var remote = syncData[syncKey];
			var shadow = S.meta.optionShadow[syncKey];
			var chosen = !shadow || S.compareVersioned(remote, shadow) >= 0 ? remote : shadow;
			if (chosen) {
				S.meta.optionShadow[syncKey] = S.clone(chosen);
				if (shadow && chosen === shadow && S.compareVersioned(shadow, remote) > 0)
					syncWrites[syncKey] = S.clone(shadow);
			}
		});

		if (migrating) {
			syncWrites[S.SYNC_SCHEMA_KEY] = S.SCHEMA_VERSION;
			S.meta.migrationVersion = S.SCHEMA_VERSION;
		}

		return S.storageSet(S.syncArea, syncWrites).then(function(ok) {
			if (S.syncArea && Object.keys(syncWrites).length)
				S.syncAvailable = !!ok;
		});
	};

	S.buildInitialCache = function(legacySnapshot, syncData) {
		S.cache = Object.create(null);
		Object.keys(S.localValues).forEach(function(key) {
			S.cache[key] = String(S.localValues[key]);
		});
		Object.keys(S.meta.optionShadow || {}).forEach(function(syncKey) {
			var envelope = S.meta.optionShadow[syncKey];
			var localKey = S.localOptionKeyForSyncKey(syncKey);
			if (!localKey || !envelope || envelope.deleted) return;
			S.cache[localKey] = String(envelope.value);
		});

		var legacyColumns = S.columnsFromValues(legacySnapshot);
		var legacyPortable = S.portableLayoutFromColumns(legacyColumns);
		var winner = S.chooseLayoutWinner(syncData);
		if (winner) {
			if (legacyPortable.length && S.layoutHash(legacyPortable) !== (winner.hash || S.layoutHash(winner.columns)))
				S.addLayoutBackup({ columns: legacyPortable, hash: S.layoutHash(legacyPortable) }, 'pre-sync migration');
			var resolved = S.resolvePortableLayout(winner.columns);
			for (var x = 0; x < resolved.length; x++)
				for (var y = 0; y < resolved[x].length; y++)
					S.cache['column.' + x + '.' + y] = String(resolved[x][y]);
			S.meta.lastAppliedLayout = S.clone(winner);
		} else if (legacyColumns.length) {
			for (var lx = 0; lx < legacyColumns.length; lx++)
				for (var ly = 0; ly < legacyColumns[lx].length; ly++)
					S.cache['column.' + lx + '.' + ly] = String(legacyColumns[lx][ly]);
		}
		S.rebuildMirror();

		if (!winner && legacyPortable.length && S.syncArea) {
			var candidate = {
				v: S.SCHEMA_VERSION,
				revision: 1,
				updatedAt: S.now(),
				updatedBy: S.meta.deviceId,
				hash: S.layoutHash(legacyPortable),
				columns: legacyPortable
			};
			var values = {};
			values[S.LAYOUT_PREFIX + S.meta.deviceId] = candidate;
			S.meta.lastAppliedLayout = S.clone(candidate);
			return S.storageSet(S.syncArea, values).then(function(ok) {
				S.syncAvailable = !!ok;
			});
		}
		return Promise.resolve();
	};

	S.fallbackToLegacy = function(error) {
		S.initError = error ? String(error.message || error) : 'Unknown initialization error';
		console.error('Humble sync initialization failed; falling back to legacy localStorage:', error);
		S.cache = S.snapshotLegacyStorage();
		S.rebuildMirror();
		S.initializing = false;
		S.initialized = true;
		S.syncAvailable = false;
		S.installLegacyAdapter();
		S.attachDevelopmentControls();
	};

	S.initialize = function() {
		var legacySnapshot = S.snapshotLegacyStorage();
		return Promise.all([
			S.storageGet(S.localArea, [S.LOCAL_VALUES_KEY, S.LOCAL_META_KEY]),
			S.storageGet(S.syncArea, null),
			S.getBookmarkTree()
		]).then(function(results) {
			var localData = results[0] || {};
			var syncData = results[1] || {};
			S.bookmarkIndex = S.buildBookmarkIndex(results[2] || []);
			return S.initialSettingsAndMigration(legacySnapshot, localData, syncData)
				.then(function() { return S.buildInitialCache(legacySnapshot, syncData); })
				.then(function() {
					S.meta.lastSyncAt = S.meta.lastSyncAt || (S.syncArea ? S.now() : null);
					S.initializing = false;
					S.initialized = true;
					S.installLegacyAdapter();
					S.listenForRemoteChanges();
					S.persistLocalSoon();
					S.attachDevelopmentControls();
				});
		}).catch(function(error) {
			S.fallbackToLegacy(error);
		});
	};

	var ready = S.initialize();
	window.HumbleStorage = Object.freeze({
		ready: ready,
		getItem: S.getItem,
		setItem: S.setItem,
		removeItem: S.removeItem,
		hasItem: function(key) { return S.getItem(key) !== null; },
		keys: function() { return Object.keys(S.cache); },
		debugInfo: S.debugInfo,
		restoreLastLayoutBackup: S.restoreLastLayoutBackup
	});

	ready.then(function() {
		S.attachDevelopmentControls();
		var script = document.createElement('script');
		script.src = 'newtab.js';
		document.body.appendChild(script);
	});
})(HumbleSync);
