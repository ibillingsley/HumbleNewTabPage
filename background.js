var tabs = {};
var size = 10;
var index = Number(localStorage.getItem('closed.index')) || 0;
var weather = null;
var weatherUrl = null;
var expireHandle = null;

// store tab info in memory
function storeTab(tab) {
	// don't store chrome:// urls
	if (tab.url && tab.url.substring(0, 6) !== 'chrome')
		tabs[tab.id] = {url: tab.url, title: tab.title || tab.url};
}

// send message to newtab page to refresh closed list
function notifyChange() {
	if (chrome.extension.sendMessage)
		chrome.extension.sendMessage('tab.closed');
}

// clear recently closed list
function clearClosed() {
	for (var i = 0; i < size; i++) {
		localStorage.removeItem('closed.' + i + '.url');
		localStorage.removeItem('closed.' + i + '.title');
	}
	index = 0;
	localStorage.setItem('closed.index', index);
	notifyChange();
}

// cache weather info in memory temporarily
function cacheWeather(data, url) {
	if (expireHandle)
		clearTimeout(expireHandle);

	weather = data;
	weatherUrl = url;
	expireHandle = setTimeout(function() {
		weather = null;
		weatherUrl = null;
		expireHandle = null;
	}, 1000*60*5);// cache 5 minutes
}

// store initial tabs
chrome.tabs.query({}, function(result) {
	for (var i in result) {
		storeTab(result[i]);
	}
});

// store tab info on change
chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
	storeTab(tab);
});

// store removed tab info
chrome.tabs.onRemoved.addListener(function(tabId, removeInfo) {
	if (!tabs[tabId])
		return;

	var url = tabs[tabId].url;
	var title = tabs[tabId].title;

	// check for duplicates
	for (var i = (index - 1 + size) % size ; ; i = (i - 1 + size) % size) {

		storedurl = localStorage.getItem('closed.' + i + '.url');
		if (!storedurl)
			break;

		if (url == storedurl) {
			// update indexes
			for (var j = (index - 1 + size) % size ; ; j = (j - 1 + size) % size) {
				nexturl = localStorage.getItem('closed.' + j + '.url');
				nexttitle = localStorage.getItem('closed.' + j + '.title');

				localStorage.setItem('closed.' + j + '.url', url);
				localStorage.setItem('closed.' + j + '.title', title);

				url = nexturl;
				title = nexttitle;

				if (j == i)
					break;
			}

			delete tabs[tabId];
			notifyChange();
			return;
		}

		if (i == index)
			break;
	}

	// store new entry
	localStorage.setItem('closed.' + index + '.url', url);
	localStorage.setItem('closed.' + index + '.title', title);
	index = (index + 1) % size;
	localStorage.setItem('closed.index', index);

	delete tabs[tabId];
	notifyChange();
});
