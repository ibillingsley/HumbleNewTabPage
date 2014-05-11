'use strict';

// store tab info in local storage
function storeTabs(tabs) {
	var cached = JSON.parse(localStorage.getItem('closed.tabs')) || {};
	for (var i = 0; i < tabs.length; i++) {
		var tab = tabs[i];
		if (tab.url && tab.url.substring(0, 15) !== 'chrome://newtab')
			cached[tab.id] = {url: tab.url, title: tab.title || tab.url};
	}
	localStorage.setItem('closed.tabs', JSON.stringify(cached));
}

// send message to newtab page to refresh closed list
function notifyChange() {
	if (chrome.extension.sendMessage)
		chrome.extension.sendMessage('tab.closed');
}

// store initial tabs
chrome.tabs.query({}, function(result) {
	storeTabs(result);
});

// store tab info on change
chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
	storeTabs([tab]);
});

// store removed tab info
chrome.tabs.onRemoved.addListener(function(tabId, removeInfo) {
	var tabs = JSON.parse(localStorage.getItem('closed.tabs')) || {};
	if (!tabs[tabId])
		return;

	var size = Number(localStorage.getItem('options.number_closed')) || 10;
	var index = Number(localStorage.getItem('closed.index')) || 0;

	var url = tabs[tabId].url;
	var title = tabs[tabId].title;

	// check for duplicates
	var i = (index - 1 + size) % size;
	while (true) {

		var storedurl = localStorage.getItem('closed.' + i + '.url');
		if (!storedurl)
			break;

		if (url == storedurl) {
			// update indexes
			var j = (index - 1 + size) % size;
			while (true) {
				var nexturl = localStorage.getItem('closed.' + j + '.url');
				var nexttitle = localStorage.getItem('closed.' + j + '.title');

				localStorage.setItem('closed.' + j + '.url', url);
				localStorage.setItem('closed.' + j + '.title', title);

				url = nexturl;
				title = nexttitle;

				if (j == i)
					break;

				j = (j - 1 + size) % size;
			}

			delete tabs[tabId];
			notifyChange();
			return;
		}

		if (i == index)
			break;

		i = (i - 1 + size) % size;
	}

	// store new entry
	localStorage.setItem('closed.' + index + '.url', url);
	localStorage.setItem('closed.' + index + '.title', title);
	index = (index + 1) % size;
	localStorage.setItem('closed.index', index);

	delete tabs[tabId];
	notifyChange();
});
