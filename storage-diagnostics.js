'use strict';

(function(S) {
	S.MAX_DIAGNOSTIC_EVENTS = 50;
	S.diagnosticEvents = [];
	S.pendingSyncWrites = 0;
	S.diagnosticRefreshTimer = null;

	S.ensureDiagnosticsMeta = function() {
		S.meta.diagnostics = S.meta.diagnostics || {};
		var d = S.meta.diagnostics;
		if (d.lastSuccessfulUploadAt == null) d.lastSuccessfulUploadAt = null;
		if (d.lastSuccessfulReadAt == null) d.lastSuccessfulReadAt = null;
		if (d.lastRemoteUpdateAt == null) d.lastRemoteUpdateAt = null;
		if (d.lastRemoteDevice == null) d.lastRemoteDevice = null;
		if (d.lastError == null) d.lastError = null;
		if (d.lastErrorAt == null) d.lastErrorAt = null;
		if (d.remoteLayoutCount == null) d.remoteLayoutCount = 0;
		if (d.unresolvedBookmarkCount == null) d.unresolvedBookmarkCount = 0;
		if (!Array.isArray(d.unresolvedBookmarks)) d.unresolvedBookmarks = [];
		if (d.syncBytes == null) d.syncBytes = null;
		return d;
	};

	S.recordDiagnosticEvent = function(message, level, details) {
		var event = {
			at: S.now(),
			level: level || 'info',
			message: String(message || ''),
			details: details == null ? null : String(details)
		};
		S.diagnosticEvents.push(event);
		while (S.diagnosticEvents.length > S.MAX_DIAGNOSTIC_EVENTS)
			S.diagnosticEvents.shift();
		S.updateDevelopmentInfo();
	};

	S.noteStorageError = function(operation, areaName, message) {
		var d = S.ensureDiagnosticsMeta();
		d.lastError = (areaName || 'storage') + ' ' + operation + ': ' + String(message || 'unknown error');
		d.lastErrorAt = S.now();
		if (areaName === 'sync') {
			S.syncAvailable = false;
			if (!S.initializing) S.persistLocalSoon();
		}
		S.recordDiagnosticEvent('storage ' + operation + ' failed', 'error', d.lastError);
	};

	S.noteStorageSuccess = function(operation, areaName, payload) {
		var d = S.ensureDiagnosticsMeta();
		if (areaName === 'sync') {
			S.syncAvailable = true;
			if (operation === 'set') d.lastSuccessfulUploadAt = S.now();
			if (operation === 'get') {
				d.lastSuccessfulReadAt = S.now();
				if (payload && typeof payload === 'object' && S.layoutCandidates)
					d.remoteLayoutCount = S.layoutCandidates(payload).length;
			}
			S.scheduleDiagnosticUsageRefresh();
			if (!S.initializing) S.persistLocalSoon();
		}
		S.updateDevelopmentInfo();
	};

	S.scheduleDiagnosticUsageRefresh = function() {
		if (S.diagnosticRefreshTimer) clearTimeout(S.diagnosticRefreshTimer);
		S.diagnosticRefreshTimer = setTimeout(function() {
			S.diagnosticRefreshTimer = null;
			S.refreshSyncUsage();
		}, 250);
	};

	S.refreshSyncUsage = function() {
		if (!S.syncArea || typeof S.syncArea.getBytesInUse !== 'function') {
			S.ensureDiagnosticsMeta().syncBytes = null;
			S.updateDevelopmentInfo();
			return Promise.resolve(null);
		}
		return new Promise(function(resolve) {
			try {
				S.syncArea.getBytesInUse(null, function(bytes) {
					if (chrome.runtime && chrome.runtime.lastError) {
						S.noteStorageError('getBytesInUse', 'sync', chrome.runtime.lastError.message);
						resolve(null);
						return;
					}
					S.ensureDiagnosticsMeta().syncBytes = Number(bytes) || 0;
					S.persistLocalSoon();
					S.updateDevelopmentInfo();
					resolve(Number(bytes) || 0);
				});
			} catch (error) {
				S.noteStorageError('getBytesInUse', 'sync', error.message || error);
				resolve(null);
			}
		});
	};

	S.refDiagnosticLabel = function(ref) {
		if (!ref) return 'unknown';
		if (ref.kind === 'special') return 'special:' + ref.id;
		var path = (ref.path || []).map(function(segment) { return segment.title || ''; }).filter(Boolean);
		if (!path.length && ref.title) path.push(ref.title);
		return (ref.rootTitle ? ref.rootTitle + ' / ' : '') + (path.join(' / ') || ref.title || 'bookmark folder');
	};

	var originalResolvePortableLayout = S.resolvePortableLayout;
	S.resolvePortableLayout = function(columns) {
		var unresolved = [];
		columns = columns || [];
		for (var x = 0; x < columns.length; x++) {
			for (var y = 0; y < columns[x].length; y++) {
				var ref = columns[x][y];
				if (!S.resolvePortableRef(ref)) unresolved.push(S.refDiagnosticLabel(ref));
			}
		}
		var d = S.ensureDiagnosticsMeta();
		d.unresolvedBookmarkCount = unresolved.length;
		d.unresolvedBookmarks = unresolved.slice(0, 10);
		if (unresolved.length)
			S.recordDiagnosticEvent('bookmark references unresolved', 'warning', unresolved.join('; '));
		if (!S.initializing) S.persistLocalSoon();
		return originalResolvePortableLayout(columns);
	};

	var originalStorageSet = S.storageSet;
	S.storageSet = function(area, values) {
		var isSync = area === S.syncArea;
		if (isSync) {
			S.pendingSyncWrites++;
			S.updateDevelopmentInfo();
		}
		return originalStorageSet(area, values).then(function(ok) {
			if (isSync) {
				S.pendingSyncWrites = Math.max(0, S.pendingSyncWrites - 1);
				S.updateDevelopmentInfo();
			}
			return ok;
		});
	};

	var originalWriteSyncOption = S.writeSyncOption;
	S.writeSyncOption = function(localKey, value, deleted) {
		S.recordDiagnosticEvent((deleted ? 'option reset: ' : 'option changed: ') + localKey);
		return originalWriteSyncOption(localKey, value, deleted);
	};

	var originalSaveLayoutCandidate = S.saveLayoutCandidate;
	S.saveLayoutCandidate = function() {
		var wasDirty = S.layoutDirty;
		return Promise.resolve(originalSaveLayoutCandidate()).then(function(result) {
			if (wasDirty && S.meta.lastAppliedLayout && S.meta.lastAppliedLayout.updatedBy === S.meta.deviceId)
				S.recordDiagnosticEvent('layout uploaded', 'info', 'revision ' + (S.meta.lastAppliedLayout.revision || 0));
			return result;
		});
	};

	var originalApplyOptionEnvelope = S.applyOptionEnvelope;
	S.applyOptionEnvelope = function(syncKey, envelope, reload) {
		var applied = originalApplyOptionEnvelope(syncKey, envelope, reload);
		if (applied && envelope && envelope.updatedBy && envelope.updatedBy !== S.meta.deviceId) {
			var d = S.ensureDiagnosticsMeta();
			d.lastRemoteUpdateAt = S.now();
			d.lastRemoteDevice = envelope.updatedBy;
			S.recordDiagnosticEvent('remote option applied', 'info', syncKey);
		}
		return applied;
	};

	var originalApplyLayoutWinner = S.applyLayoutWinner;
	S.applyLayoutWinner = function(winner, reload, reason) {
		var applied = originalApplyLayoutWinner(winner, reload, reason);
		if (winner && winner.updatedBy && winner.updatedBy !== S.meta.deviceId) {
			var d = S.ensureDiagnosticsMeta();
			d.lastRemoteUpdateAt = S.now();
			d.lastRemoteDevice = winner.updatedBy;
			if (applied)
				S.recordDiagnosticEvent('remote layout applied', 'info', 'revision ' + (winner.revision || 0));
		}
		return applied;
	};

	var originalAddLayoutBackup = S.addLayoutBackup;
	S.addLayoutBackup = function(layout, reason) {
		var before = (S.meta.layoutBackups || []).length;
		originalAddLayoutBackup(layout, reason);
		var after = (S.meta.layoutBackups || []).length;
		if (after > before) S.recordDiagnosticEvent('layout backup created', 'warning', reason || 'sync');
	};

	var originalRestoreLastLayoutBackup = S.restoreLastLayoutBackup;
	S.restoreLastLayoutBackup = function() {
		S.recordDiagnosticEvent('restore previous layout requested');
		return originalRestoreLastLayoutBackup().then(function(ok) {
			S.recordDiagnosticEvent(ok ? 'previous layout restored' : 'layout restore failed', ok ? 'info' : 'error');
			return ok;
		});
	};

	S.refreshDiagnosticSnapshot = function() {
		if (!S.syncArea) {
			S.updateDevelopmentInfo();
			return Promise.resolve();
		}
		return Promise.all([
			S.storageGet(S.syncArea, null).then(function(syncData) {
				S.ensureDiagnosticsMeta().remoteLayoutCount = S.layoutCandidates(syncData).length;
			}),
			S.refreshSyncUsage()
		]).then(function() {
			S.persistLocalSoon();
			S.updateDevelopmentInfo();
		});
	};

	S.syncNow = function() {
		S.recordDiagnosticEvent('manual sync requested');
		var work = Promise.resolve();
		if (S.layoutSaveTimer) {
			clearTimeout(S.layoutSaveTimer);
			S.layoutSaveTimer = null;
		}
		if (S.layoutDirty) work = work.then(function() { return S.saveLayoutCandidate(); });
		return work.then(function() { return S.refreshDiagnosticSnapshot(); }).then(function() {
			S.recordDiagnosticEvent('manual sync completed');
			return true;
		});
	};

	S.reloadRemoteState = function() {
		S.recordDiagnosticEvent('remote state reload requested');
		if (!S.syncArea) return Promise.resolve(false);
		return S.storageGet(S.syncArea, null).then(function(syncData) {
			var changed = false;
			Object.keys(syncData || {}).forEach(function(syncKey) {
				if (syncKey.indexOf(S.OPTION_PREFIX) === 0 || syncKey.indexOf(S.ROOT_VISIBILITY_PREFIX) === 0) {
					var envelope = syncData[syncKey];
					if (envelope && S.applyOptionEnvelope(syncKey, envelope, false)) changed = true;
				}
			});
			var winner = S.chooseLayoutWinner(syncData);
			if (winner && S.applyLayoutWinner(winner, false, 'manual remote reload')) changed = true;
			S.ensureDiagnosticsMeta().remoteLayoutCount = S.layoutCandidates(syncData).length;
			S.persistLocalSoon();
			S.updateDevelopmentInfo();
			S.recordDiagnosticEvent('remote state reloaded');
			if (changed) S.scheduleReload();
			return true;
		});
	};

	S.syncStatus = function() {
		if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'Offline';
		if (!S.syncArea || !S.syncAvailable) return 'Error';
		if (S.pendingSyncWrites > 0 || S.layoutDirty || S.layoutSaveTimer) return 'Pending';
		return 'OK';
	};

	S.formatBytes = function(bytes) {
		if (bytes == null) return 'Unknown';
		if (bytes < 1024) return bytes + ' B';
		return (bytes / 1024).toFixed(1) + ' KB';
	};

	S.eventLogText = function() {
		return S.diagnosticEvents.map(function(event) {
			var time = new Date(event.at).toLocaleTimeString();
			return time + ' [' + event.level.toUpperCase() + '] ' + event.message + (event.details ? ' — ' + event.details : '');
		}).join('\n');
	};

	S.diagnosticsText = function() {
		var info = S.debugInfo();
		var d = S.ensureDiagnosticsMeta();
		var manifest = chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
		var current = S.currentPortableLayout ? S.currentPortableLayout() : { hash: 'unknown' };
		var lines = [
			'Humble New Tab Page ' + (manifest.version || 'unknown'),
			'Browser: ' + navigator.userAgent,
			'Schema: ' + S.SCHEMA_VERSION,
			'Sync status: ' + S.syncStatus(),
			'Browser sync: ' + (info.syncEnabled ? 'Enabled' : 'Unavailable'),
			'Device: ' + info.deviceId,
			'Layout revision: ' + info.layoutRevision,
			'Layout hash: ' + current.hash,
			'Last successful upload: ' + S.formatTimestamp(d.lastSuccessfulUploadAt),
			'Last remote update: ' + S.formatTimestamp(d.lastRemoteUpdateAt),
			'Last remote device: ' + (d.lastRemoteDevice || 'None'),
			'Pending local changes: ' + ((S.pendingSyncWrites > 0 || S.layoutDirty || S.layoutSaveTimer) ? 'yes' : 'no'),
			'Remote layouts: ' + d.remoteLayoutCount,
			'Sync storage usage: ' + S.formatBytes(d.syncBytes),
			'Backups: ' + info.backupCount,
			'Conflicts: ' + info.conflictCount,
			'Unresolved bookmarks: ' + d.unresolvedBookmarkCount,
			'Last error: ' + (d.lastError || 'None')
		];
		if (d.unresolvedBookmarks.length)
			lines.push('Unresolved refs: ' + d.unresolvedBookmarks.join('; '));
		if (S.diagnosticEvents.length) {
			lines.push('', 'Recent events:', S.eventLogText());
		}
		return lines.join('\n');
	};

	S.copyText = function(text) {
		if (navigator.clipboard && navigator.clipboard.writeText)
			return navigator.clipboard.writeText(text).then(function() { return true; }).catch(function() { return S.copyTextFallback(text); });
		return Promise.resolve(S.copyTextFallback(text));
	};
	S.copyTextFallback = function(text) {
		var textarea = document.createElement('textarea');
		textarea.value = text;
		textarea.style.position = 'fixed';
		textarea.style.opacity = '0';
		document.body.appendChild(textarea);
		textarea.select();
		var ok = false;
		try { ok = document.execCommand('copy'); } catch (error) { ok = false; }
		document.body.removeChild(textarea);
		return ok;
	};

	var originalUpdateDevelopmentInfo = S.updateDevelopmentInfo;
	S.updateDevelopmentInfo = function() {
		originalUpdateDevelopmentInfo();
		var d = S.ensureDiagnosticsMeta();
		var current = S.currentPortableLayout ? S.currentPortableLayout() : { hash: 'Pending' };
		var pending = S.pendingSyncWrites > 0 || S.layoutDirty || !!S.layoutSaveTimer;
		var manifest = chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
		var fields = {
			dev_version: manifest.version || 'Unknown',
			dev_sync_health: S.syncStatus(),
			dev_last_upload: S.formatTimestamp(d.lastSuccessfulUploadAt),
			dev_last_remote: S.formatTimestamp(d.lastRemoteUpdateAt),
			dev_remote_device: d.lastRemoteDevice || 'None',
			dev_layout_hash: current.hash || 'None',
			dev_remote_layouts: String(d.remoteLayoutCount),
			dev_pending: pending ? 'Yes' : 'No',
			dev_storage_usage: S.formatBytes(d.syncBytes),
			dev_unresolved: String(d.unresolvedBookmarkCount),
			dev_last_error: d.lastError || 'None'
		};
		Object.keys(fields).forEach(function(id) {
			var element = document.getElementById(id);
			if (element) element.value = fields[id];
		});
		var log = document.getElementById('dev_event_log');
		if (log) {
			log.value = S.eventLogText();
			log.scrollTop = log.scrollHeight;
		}
	};

	var originalAttachDevelopmentControls = S.attachDevelopmentControls;
	S.attachDevelopmentControls = function() {
		originalAttachDevelopmentControls();
		function bind(id, handler) {
			var button = document.getElementById(id);
			if (!button || button.dataset.bound) return;
			button.dataset.bound = '1';
			button.onclick = function() {
				button.disabled = true;
				Promise.resolve(handler(button)).finally(function() {
					button.disabled = false;
					S.updateDevelopmentInfo();
				});
				return false;
			};
		}
		bind('dev_sync_now', function() { return S.syncNow(); });
		bind('dev_reload_remote', function() { return S.reloadRemoteState(); });
		bind('dev_copy_diagnostics', function(button) {
			return S.refreshDiagnosticSnapshot().then(function() {
				return S.copyText(S.diagnosticsText());
			}).then(function(ok) {
				var previous = button.textContent;
				button.textContent = ok ? 'Copied' : 'Copy failed';
				setTimeout(function() { button.textContent = previous; }, 1200);
			});
		});
		S.refreshDiagnosticSnapshot();
		S.updateDevelopmentInfo();
	};

	if (chrome.storage && chrome.storage.onChanged) {
		chrome.storage.onChanged.addListener(function(changes, areaName) {
			if (areaName !== 'sync') return;
			var remoteDevices = [];
			Object.keys(changes || {}).forEach(function(key) {
				var incoming = changes[key] && changes[key].newValue;
				if (incoming && incoming.updatedBy && incoming.updatedBy !== S.meta.deviceId &&
					remoteDevices.indexOf(incoming.updatedBy) < 0)
					remoteDevices.push(incoming.updatedBy);
			});
			if (!remoteDevices.length) return;
			var d = S.ensureDiagnosticsMeta();
			d.lastRemoteUpdateAt = S.now();
			d.lastRemoteDevice = remoteDevices[remoteDevices.length - 1];
			S.recordDiagnosticEvent('remote change received', 'info', remoteDevices.join(', '));
			S.persistLocalSoon();
		});
	}

	window.addEventListener('online', function() {
		S.recordDiagnosticEvent('browser is online');
		S.refreshDiagnosticSnapshot();
	});
	window.addEventListener('offline', function() {
		S.recordDiagnosticEvent('browser is offline', 'warning');
	});

	S.recordDiagnosticEvent('sync diagnostics initialized');
})(HumbleSync);
