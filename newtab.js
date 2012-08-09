// render a single bookmark node
function render(node, target) {
	var li = document.createElement('li');
	var a = document.createElement('a');

	var url = node.url || node.appLaunchUrl;
	a.href = url || '#';
	a.innerText = node.title || node.name;
	a.className = getClass(node);

	var icon = getIcon(node);
	if (icon)
		a.style.backgroundImage = 'url(' + icon + ')';

	if (!url && !node.children)
		a.style.pointerEvents = 'none';

	li.appendChild(a);
	
	// folder
	if (node.children) {
		// render children
		if (localStorage.getItem('open.' + node.id)) {
			a.className = getClass(node, true);
			getChildrenFunction(node)(function(result) {
				renderAll(result, li);
			});
		}
		
		// click handlers
		addHandlers(node, a);
		enableDragFolder(node, a);
	}

	target.appendChild(li);
	return li;
}

// render an array of bookmark nodes
function renderAll(nodes, target, toplevel) {
	var ul = document.createElement('ul');
	for (var i = 0; i < nodes.length; i++) {
		var node = nodes[i];
		// skip extensions and duplicated child folders
		if (toplevel || (node.isApp != false && !coords[node.id]))
			render(node, ul);
	}
	if (ul.childNodes.length == 0)
		render({ id: 'empty', title: '< Empty >' }, ul);
	target.appendChild(ul);
	return ul;
}

// render column with given index
function renderColumn(index, target) {
	var ids = columns[index];
	if (ids.length == 1 && ids[0] != 'weather')
		getChildrenFunction({id: ids[0]})(function(result) {
			renderAll(result, target);
			addColumnHandlers(index, target);
		});
	else if (ids.length > 0) {
		var i = 0;
		var nodes = [];
		// get all nodes for column
		var callback = function(result) {
			for (var j = 0; j < result.length; j++)
				nodes.push(result[j]);
			i++;
			if (i < ids.length)
				getSubTree(ids[i], callback);
			else {
				// render node list
				renderAll(nodes, target, true);
				addColumnHandlers(index, target);
			}
		};
		getSubTree(ids[i], callback);
	}
}

// render all columns to main div
function renderColumns() {
	// clear main div
	var target = document.getElementById('main');
	while (target.hasChildNodes())
		target.removeChild(target.lastChild);

	// render columns
	for (var i = 0; i < columns.length; i++) {
		var column = document.createElement('div');
		column.className = 'column';
		column.style.width = (1 / columns.length) * 100 + '%';

		// enable drag and drop
		enableDragColumn(i, column);

		target.appendChild(column);
		renderColumn(i, column);
	}

	enableDragDrop();
}

// enables click and context menu for given folder
function addHandlers(node, a) {
	// click handler
	a.onclick = function() {
		toggle(node, a, getChildrenFunction(node));
		return false;
	};

	// context menu handler
	var items = getMenuItems(node);

	// column layout items
	if (!getConfig('lock')) {
		items.push(null);// spacer
		items.push({
			label: 'Create new column',
			action: function() {
				addColumn([node.id]);
			}
		});

		if (coords[node.id]) {
			var pos = coords[node.id];
			if (pos.y > 0)
				items.push({
					label: 'Move folder up',
					action: function() {
						addRow(node.id, pos.x, pos.y - 1);
					}
				});
			if (pos.y < columns[pos.x].length - 1)
				items.push({
					label: 'Move folder down',
					action: function() {
						addRow(node.id, pos.x, pos.y + 2);
					}
				});
			if (pos.x > 0)
				items.push({
					label: 'Move folder left',
					action: function() {
						addRow(node.id, pos.x - 1);
					}
				});
			if (pos.x < columns.length - 1)
				items.push({
					label: 'Move folder right',
					action: function() {
						addRow(node.id, pos.x + 1);
					}
				});
			if (root.indexOf(node.id) < 0)
				items.push({
					label: 'Remove folder',
					action: function() {
						removeRow(pos.x, pos.y);
					}
				});
		}
	}

	a.oncontextmenu = function(event) {
		renderMenu(items, event.pageX, event.pageY);
		return false;
	}
}

// enables context menu for given column
function addColumnHandlers(index, ul) {
	var items = [];
	var ids = columns[index];

	// single folder items
	if (ids.length == 1)
		items = getMenuItems({id: ids[0]});

	// column layout items
	if (!getConfig('lock') && columns.length > 1) {
		items.push(null);// spacer
		if (index > 0)
			items.push({
				label: 'Move column left',
				action: function() {
					addColumn(ids, index - 1);
				}
			});
		if (index < columns.length - 1)
			items.push({
				label: 'Move column right',
				action: function() {
					addColumn(ids, index + 2);
				}
			});
		items.push({
			label: 'Remove column',
			action: function() {
				removeColumn(index);
			}
		});
		if (ids.length == 1) {
			if (index > 0)
				items.push({
					label: 'Move folder left',
					action: function() {
						addRow(ids[0], index - 1);
					}
				});
			if (index < columns.length - 1)
				items.push({
					label: 'Move folder right',
					action: function() {
						addRow(ids[0], index + 1);
					}
				});
		}
	}

	if (items.length > 0)
		ul.oncontextmenu = function(event) {
			if (event.target.tagName == 'A')
				return true;
			renderMenu(items, event.pageX, event.pageY);
			return false;
		}
}

// gets context menu items for given node
function getMenuItems(node) {
	var items = [];
	if (node.id == 'weather')
		items.push({
			label: 'Update weather',
			action: function() {
				refreshWeather();
			}
		});
	else
		items.push({
			label: 'Open all links in folder',
			action: function() {
				openLinks(node);
			}
		});
	if (node.id == 'closed')
		items.push({
			label: 'Clear recently closed',
			action: function() {
				var bg = chrome.extension.getBackgroundPage();
				if (bg) bg.clearClosed();
			}
		});
	if (node.id == 'apps')
		items.push({
			label: 'Manage apps',
			action: function() {
				window.open('https://chrome.google.com/webstore/user/purchases');
			}
		});
	return items;
}

// wraps click handler for menu items
function onMenuClick(item) {
	return function() {
		item.action();
		return false;
	};
}

// renders a popup menu at given coordinates
function renderMenu(items, x, y) {
	var ul = document.createElement('ul');
	ul.className = 'menu';
	for (var i = 0; i < items.length; i++) {
		var li = document.createElement('li');
		if (items[i]) {
			var a = document.createElement('a');
			a.href="#";
			a.innerText = items[i].label;
			a.onclick = onMenuClick(items[i]);

			li.appendChild(a);
		} else if (i > 0 && i < items.length - 1)
			li.appendChild(document.createElement('hr'));

		ul.appendChild(li);
	}
	document.body.appendChild(ul);
	ul.style.left = Math.max(Math.min(x, window.innerWidth + window.scrollX - ul.clientWidth), 0) + 'px';
	ul.style.top = Math.max(Math.min(y, window.innerHeight + window.scrollY - ul.clientHeight), 0) + 'px';

	setTimeout(function() {
		document.onclick = function() {
			closeMenu(ul);
			return true;
		};
		document.oncontextmenu = function() {
			closeMenu(ul);
			return true;
		}
		document.onkeydown = function(event) {
			if (event.keyCode == 27)
				closeMenu(ul);
			return true;
		};
	}, 0);
	return ul;
}

// removes the given popup menu
function closeMenu(ul) {
	document.body.removeChild(ul);
	document.onclick = null;
	document.oncontextmenu = null;
	document.onkeydown = null;
}

var dragIds;

// enable drag and drop of column
function enableDragColumn(id, column) {
	if (getConfig('lock'))
		return;

	column.draggable = true;

	column.ondragstart = function(event) {
		dragIds = columns[id];
		event.dataTransfer.effectAllowed = 'move';
		this.classList.add('dragstart');
	};
	column.ondragend = function(event) {
		dragIds = null;
		this.classList.remove('dragstart');
		clearDropTarget();
	}
}

var dropTarget;

// enable drag and drop of folder
function enableDragFolder(node, a) {
	if (getConfig('lock'))
		return;
	
	a.draggable = true;
	a.ondragstart = function(event) {
		dragIds = [node.id];
		event.stopPropagation();
		event.dataTransfer.effectAllowed = 'move copy';
		this.classList.add('dragstart');
	};
	a.ondragend = function(event) {
		dragIds = null;
		this.classList.remove('dragstart');
		clearDropTarget();
	}
}

// init drag and drop handlers
function enableDragDrop() {
	var main = document.getElementById('main');

	if (getConfig('lock')) {
		main.ondragover = null;
		main.ondragleave = null;
		main.ondrop = null;
		return;
	}
	
	main.ondragover = function(event) {
		event.preventDefault();
		event.dataTransfer.dropEffect = 'move';
		// highlight drop target
		var target = getDropTarget(event);
		if (target) {
			clearDropTarget();
			dropTarget = target;
			var bordercss = 'solid 2px ' + getConfig('font_color');
			if (target.tagName == 'LI' || target.tagName == 'UL') {
				if (event.pageY - target.offsetTop > target.clientHeight / 2) {
					target.style.borderBottom = bordercss;
					target.style.margin = '0 0 -2px 0';
				} else {
					target.style.borderTop = bordercss;
					target.style.margin = '-2px 0 0 0';
				}
			} else if (target.className == 'column') {
				if (event.pageX - target.offsetLeft > target.clientWidth / 2) {
					target.style.borderRight = bordercss;
					target.style.margin = '0';
				} else {
					target.style.borderLeft = bordercss;
					target.style.margin = '0 2px 0 -2px';
				}
			}
		}
		return false;
	}

	main.ondragleave = function(event) {
		clearDropTarget();
	}

	main.ondrop = function(event) {
		event.stopPropagation();

		var target = getDropTarget(event);
		if (!target)
			return false;

		// calculate drop coordinates
		var x = getDropX(target, event);
		var y = getDropY(target, event);

		if (dragIds.length == 1 && y != null)
			addRow(dragIds[0], x, y);
		else {
			if (event.pageX - target.offsetLeft > target.clientWidth / 2)
				x++;
			addColumn(dragIds, x);
		}
		
		return false;
	}
}

// gets proper drop target element
function getDropTarget(event) {
	var target = event.target;
	if (target && target.tagName == 'A' && dragIds.length == 1) {
		// get parent folder until toplevel
		while (target && 
			target.parentNode.parentNode &&
			target.parentNode.parentNode.className != 'column') {
			// target should be LI
			target = target.parentNode;
		}
		// if single-folder column, get the UL
		if (target && target.tagName == 'LI' &&
			columns[getDropX(target, event)].length == 1)
			target = target.parentNode;
		// target should be LI or UL by here...
	} else
		while (target && target.className != 'column')
			target = target.parentNode;// target column

	return target;
}

// gets x coordinate of drop target
function getDropX(target, event) {
	var x = null;
	while (target && target.className != 'column')
		target = target.parentNode;
	if (target) {
		x = 0;
		for (; target.previousSibling; x++)
			target = target.previousSibling;
	}
	return x;
}

// gets y coordinate of drop target
function getDropY(target, event) {
	var y = null;
	if (target.tagName == 'LI') {
		y = 0;
		if (event.pageY - target.offsetTop > target.clientHeight / 2)
			y++;
		for (; target.previousSibling; y++)
			target = target.previousSibling;
	} else if (target.tagName == 'UL') {
		y = 0;
		if (event.pageY - target.offsetTop > target.clientHeight / 2)
			y++;
	}
	return y;
}

// clears droptarget styles
function clearDropTarget() {
	if (dropTarget) {
		dropTarget.style.border = null;
		dropTarget.style.margin = null;
	}
	dropTarget = null;
}

// gets function that returns children of node
function getChildrenFunction(node) {
	switch(node.id) {
		case 'top':
			return function(callback) {
				chrome.topSites.get(function(result) {
					callback(result);
				});
			};
		case 'apps':
			return function(callback) {
				chrome.management.getAll(function(result) {
					callback(result);
				});
			};
		case 'recent':
			return function(callback) {
				chrome.bookmarks.getRecent(10, function(result) {
					callback(result);
				});
			};
		case 'closed':
			return function(callback) {
				getClosed(function(result) {
					callback(result);
				});
			};
		case 'weather':
			if (node.children)
				return function(callback) {
					callback(node.children);
				}
			else
				return function(callback) {
					getWeather(function(result) {
						callback(result[0].children);
					});
				}
		default:
			if  (node.children)
				return function(callback) {
					callback(node.children);
				};
			else
				return function(callback) {
					chrome.bookmarks.getSubTree(node.id, function(result) {
						if (result)
							callback(result[0].children);
						else {
							// remove missing bookmark locations
							if (coords[node.id])
								removeRow(coords[node.id].x, coords[node.id].y);
						}
					});
				};
	}
}

// gets the subtree for given id
function getSubTree(id, callback) {
	switch(id) {
		case 'top':
			callback([{ title: 'Most visited', id: 'top', children: true}]);
			break;
		case 'apps':
			callback([{ title: 'Apps', id: 'apps', children: true }]);
			break;
		case 'recent':
			callback([{ title: 'Recent bookmarks', id: 'recent', children: true }]);
			break;
		case 'closed':
			callback([{ title: 'Recently closed', id: 'closed', children: true }]);
			break;
		case 'weather':
			getWeather(function(result) {
				callback(result);
			});
			break;
		default:
			chrome.bookmarks.getSubTree(id, function(result) {
				if (result)
					callback(result);
				else {
					// remove missing bookmark locations
					if (coords[id])
						removeRow(coords[id].x, coords[id].y);
				}
			});
	}
}

// gets css class for node
function getClass(node, isopen) {
	switch(node.id) {
		case 'top':
			return 'folder top';
		case 'apps':
			return 'folder apps';
		case 'recent':
			return 'folder recent';
		case 'closed':
			return 'folder closed';
		case 'weather':
			return 'folder weather';
		case 'empty':
			return 'empty';
		default:
			if (node.children) {
				if (isopen)
					return 'folder open';
				else
					return 'folder';
			} else
				return null;
	}
}

// gets best icon for an node
function getIcon(node) {
	if (node.icons) {
		var url;
		var size;
		for (var i in node.icons) {
			var icon = node.icons[i];
			if (icon.url && (!size || (icon.size < size && icon.size > 15))) {
				url = icon.url;
				size = icon.size;
			}
		}
		if (url)
			return url;
	} else if (node.icon)
		return node.icon;
	else if (node.url || node.appLaunchUrl)
		return 'chrome://favicon/' + (node.url || node.appLaunchUrl);

	return null;
}

// toggle folder open state
function toggle(node, a) {
	var isopen = localStorage.getItem('open.' + node.id);
	a.className = getClass(node, !isopen);

	if (isopen) {
		// close folder
		localStorage.removeItem('open.' + node.id);
		if (a.nextSibling)
			animate(node, a, isopen);
	} else {
		localStorage.setItem('open.' + node.id, true);
		// open folder
		if (a.nextSibling)
			animate(node, a, isopen);
		else
			getChildrenFunction(node)(function(result) {
				if (!a.nextSibling && localStorage.getItem('open.' + node.id)) {
					renderAll(result, a.parentNode);
					animate(node, a, isopen);
				}
			});
	}
}

var toggleAction;
var toggleHandle;
var wrap;

// smoothly open or close folder
function animate(node, a, isopen) {
	// finish last animation
	if (toggleAction) {
		clearTimeout(toggleHandle);
		if (wrap != a.nextSibling)
			toggleAction();
		toggleAction = null;
	}
	var target = a.parentNode;
	// wrapper for animation
	if (!wrap) {
		wrap = document.createElement('div');
		wrap.style.height = isopen ? a.nextSibling.clientHeight + 'px' : 0;
		wrap.style.opacity = isopen ? 1 : 0;
		wrap.appendChild(a.nextSibling);
		target.appendChild(wrap);	
	}
	wrap.className = 'wrap';
	wrap.style.pointerEvents = isopen ? 'none' : null;

	setTimeout(function() {
		wrap.style.height = isopen ? 0 : wrap.firstChild.clientHeight + 'px';
		wrap.style.opacity = isopen ? 0 : 1;
	}, 0);

	toggleAction = function() {
		if (isopen)
			target.removeChild(wrap);
		else {
			wrap.className = null;
			wrap.style.height = null;	
			// removing wrapper messes up in-progress click events...
			// target.appendChild(wrap.firstChild);
			// target.removeChild(wrap);
		}	
		toggleAction = null;
		wrap = null;
	};
	var duration = scale(getConfig('slide'), .2, 1) * 1000;
	toggleHandle = setTimeout(toggleAction, duration);
}

// opens immediate children of given node in new tabs
function openLinks(node) {
	chrome.tabs.getCurrent(function(tab) {
		getChildrenFunction(node)(function(result) {
			for (var i = 0; i < result.length; i++) {
				var url = result[i].url || result[i].appLaunchUrl;
				if (url)
					chrome.tabs.create({url: url, active: false, openerTabId: tab.id});
			}
		});
	});
}

var columns; // columns[x][y] = id
var root; // root[] = id
var coords; // coords[id] = {x:x, y:y}

// ensure root folders are included
function verifyColumns() {
	var missing = root.slice(0);
	for (var x = 0; x < columns.length; x++) {
		for (var y = 0; y < columns[x].length; y++) {
			var i = missing.indexOf(columns[x][y]);
			if (i > -1)
				missing.splice(i, 1);
		}
		if (columns[x].length == 0) {
			columns.splice(x, 1);
			x--;
		}
	}

	if (columns.length == 0)
		columns.push([]);
	// add missing root items
	var column = columns[0];
	for (var i = 0; i < missing.length; i++)
		column.push(missing[i]);

	// populate coordinate map
	coords = {};
	for (var x = 0; x < columns.length; x++)
		for (var y = 0; y < columns[x].length; y++)
			coords[columns[x][y]] = { x: x, y: y};
}

// load columns from storage or default
function loadColumns() {
	columns = [];
	for (var x = 0; ; x++) {
		var row = [];
		for (var y = 0; ; y++) {
			var id = localStorage.getItem('column.' + x + '.' + y);
			if (id) row.push(id); else break;
		}
		if (row.length > 0) columns.push(row); else break;
	}

	if (root) {
		verifyColumns();
		renderColumns();
	} else {
		chrome.bookmarks.getTree(function(result) {
			// init root nodes
			var nodes = result[0].children;
			root = [];
			for (var i = 0; i < nodes.length; i++)
				root.push(nodes[i].id);
			root.push('top', 'apps', 'recent', 'weather', 'closed');
			verifyColumns();
			renderColumns();
		});
	}
}

// saves current column configuration to storage
function saveColumns() {
	// clear previous config
	for (var x = 0; ; x++) {
		for (var y = 0; ; y++) {
			var id = localStorage.getItem('column.' + x + '.' + y);
			if (id)
				localStorage.removeItem('column.' + x + '.' + y);
			else
				break;
		}
		if (y == 0)
			break;
	}
	verifyColumns();
	// save new config
	for (var x = 0; x < columns.length; x++) {
		for (var y = 0; y < columns[x].length; y++) {
			localStorage.setItem('column.' + x +'.' + y, columns[x][y]);
		}
	}
	// refresh
	loadColumns();
}

// creates and saves a new column
function addColumn(ids, index) {
	var column = ids.slice(0);
	// remove previous locations
	for (var x = 0; x < columns.length; x++) {
		for (var y = 0; y < columns[x].length; y++ ) {
			if (ids.indexOf(columns[x][y]) > -1) {
				columns[x].splice(y, 1);
				y--;
			}
		}
	}
	// insert new id
	if (index == null)
		index = columns.length;
	columns.splice(Math.min(index, columns.length), 0, column);

	// save
	saveColumns();
}

// removes given column
function removeColumn(index) {
	columns.splice(index, 1);
	saveColumns();
}

// creates and saves a new row
function addRow(id, xpos, ypos) {
	if (ypos == null)
		ypos = columns[xpos].length;

	// remove previous locations
	for (var x = 0; x < columns.length; x++) {
		var i = columns[x].indexOf(id);
		if (i > -1) {
			columns[x].splice(i, 1);
			if (x == xpos && ypos > i)
				ypos--;
		}
		if (columns[x].length == 0) {
			columns.splice(x, 1);
			x--;
			if (xpos > x)
				xpos--;
		}
	}
	// insert new id
	columns[xpos].splice(Math.min(ypos, columns[xpos].length), 0, id);

	// save
	saveColumns();
}

// removes given row
function removeRow(xpos, ypos) {
	columns[xpos].splice(ypos, 1);
	saveColumns();
}

// get recently closed tabs
function getClosed(callback) {
	var closed = [];
	var size = 10;
	var start = (Number(localStorage.getItem('closed.index')) - 1) || 0;

	for (var i = 0; i < size; i++) {
		var index = (start - i + size) % size;
		url = localStorage.getItem('closed.' + index + '.url');
		if (!url)
			break;

		title = localStorage.getItem('closed.' + index + '.title');
		closed.push({url: url, title: title});
	}

	callback(closed);
}

// refresh recently closed tab lists
function refreshClosed() {
	var targets = [];
	var folders = document.getElementsByClassName('closed');
	for (var i = 0; i < folders.length; i++) {
		var a = folders[i];
		if (a.nextSibling) {
			a.parentNode.removeChild(a.nextSibling);
			targets.push(a.parentNode);
		}
	}
	if (folders.length == 0) {
		var target = document.getElementsByClassName('column')[coords['closed'].x];
		target.removeChild(target.firstChild);
		targets.push(target);
	}

	getChildrenFunction({id: 'closed'})(function(result) {
		for (var i = 0; i < targets.length; i++)
			renderAll(result, targets[i]);
	});
}

// gets weather info from unofficial google api
function getWeather(callback) {
	var url = 'http://www.google.com/ig/api?weather=' + 
		encodeURIComponent(getConfig('weather_location')) + 
		'&hl=' + getConfig('weather_units');

	// check cache
	var bg = chrome.extension.getBackgroundPage();
	if (bg && bg.weatherUrl == url) {
		callback(bg.weather);
		return;
	}

	// show loading...
	callback([{ id: 'weather', title: 'Loading weather...', children: true }]);

	var onerror = function() {
		var targets = document.getElementsByClassName('weather');
		for (var i = 0; i < targets.length; i++){
			targets[i].innerText = 'Error loading weather';
			targets[i].classList.add('error');
		}
	};

	// request weather data
	var request = new XMLHttpRequest();

	request.onload = function(event) {
		var nodes = [];
		var response = request.responseXML;
		var isC = getConfig('weather_units') == 'en-gb';

		var current = response.getElementsByTagName('current_conditions')[0];

		// validate
		if (!current) {
			onerror();
			return;
		}
		// correct location value
		var city = getWeatherData(response, 'city');
		if (city != getConfig('weather_location')) {
			var input = document.getElementById('options_weather_location');
			input.value = city;
			input.onchange();
			callback([]);
			return;
		}

		// current conditions
		var parentnode = {
			id: 'weather',
			title: getWeatherData(current, isC ? 'temp_c' : 'temp_f') + '°' +
				(isC ? 'C' : 'F') + ' ' + 
				getWeatherData(current, 'condition'),
			icon: 'http://www.google.com' + getWeatherData(current, 'icon')
		};

		// forecast
		var forecast = response.getElementsByTagName('forecast_conditions');
		for (var i = 0; i < forecast.length; i++) {
			nodes.push({
				title: getWeatherData(forecast[i], 'day_of_week') + ' ' +
				 getWeatherData(forecast[i], 'low') + '° | ' + 
				 getWeatherData(forecast[i], 'high') + '° ' +
				 getWeatherData(forecast[i], 'condition'),
				icon: 'http://www.google.com' + getWeatherData(forecast[i], 'icon')
			});
		}
		parentnode.children = nodes;
		refreshWeather([parentnode], url);
	};

	request.onabort = onerror;
	request.onerror = onerror;
	request.ontimeout = onerror;

	request.open('GET', url, true);
	request.send();
}

// gets xml node data
function getWeatherData(parent, tag) {
	return parent.getElementsByTagName(tag)[0].attributes.data.value;
}

// refreshes weather items
function refreshWeather(data, url) {
	// clear cache
	var bg = chrome.extension.getBackgroundPage();
	if (bg) bg.cacheWeather(data, url);
	// render
	var targets = document.getElementsByClassName('weather');
	for (var i = 0; i < targets.length; i++) {
		var target = targets[i].parentNode;
		getSubTree('weather', function(result) {
			var li = render(result[0], target.parentNode, 'weather');
			target.parentNode.replaceChild(li, target);
		});
	}
}

// options : default values
var config = {
	font: 'Sans-serif',
	font_size: 16,
	theme: 'Default',
	font_color: '#555555',
	background_color: '#ffffff',
	highlight_color: '#E4F4FF',
	highlight_font_color: '#000000',
	shadow_color: '#57B0FF',
	background_image: '',
	background_align: 'top',
	background_repeat: 'repeat',
	shadow_blur: 1,
	highlight_round: 1,
	fade: 1,
	spacing: 1,
	h_margin: 1,
	v_margin: 1,
	slide: 1,
	hide_options: 0,
	lock: 0,
	weather_location: 'Toronto, ON',
	weather_units: 'en-gb'
};

// color theme values
var themes = {
	Default: {},
	Classic: {
		font_color: '#000000',
		background_color: '#ffffff',
		highlight_color: '#3399ff',
		highlight_font_color: '#ffffff',
		shadow_color: '#97cbff'
	},
	Dusk: {
		font_color: '#c8b9be',
		background_color: '#56546b',
		highlight_color: '#494d5a',
		highlight_font_color: '#ffd275',
		shadow_color: '#000000'
	},
	Elegant: {
		font_color: '#888888',
		background_color: '#f6f6f6',
		highlight_color: '#ffffff',
		highlight_font_color: '#000000',
		shadow_color: '#aaaaaa'
	},
	Frosty: {
		font_color: '#3e5e82',
		background_color: '#e4eef3',
		highlight_color: '#0080c0',
		highlight_font_color: '#ffffff',
		shadow_color: '#8080ff'
	},
	Hacker: {
		font_color: '#00ff00',
		background_color: '#000000',
		highlight_color: '#00ff00',
		highlight_font_color: '#000000',
		shadow_color: '#ff0000'
	},
	Melon: {
		font_color: '#594526',
		background_color: '#f8ffe1',
		highlight_color: '#ff8000',
		highlight_font_color: '#ffff80',
		shadow_color: '#ff80c0'
	},
	Midnight: {
		font_color: '#bfdfff',
		background_color: '#101827',
		highlight_color: '#000000',
		highlight_font_color: '#80ecff',
		shadow_color: '#0080ff'
	},
	Slate: {
		font_color: '#555555',
		background_color: '#b7babf',
		highlight_color: '#aaaaaa',
		highlight_font_color: '#000000',
		shadow_color: '#2a2a2a'
	},
	Trees: {
		font_color: '#cdd088',
		background_color: '#566157',
		highlight_color: '#4d674b',
		highlight_font_color: '#ffff80',
		shadow_color: '#183010'
	},
	Valentine: {
		font_color: '#895fc2',
		background_color: '#eae1ff',
		highlight_color: '#ffb7f0',
		highlight_font_color: '#f00000',
		shadow_color: '#ffffff'
	},
	Warm: {
		font_color: '#824100',
		background_color: '#ffeedd',
		highlight_color: '#fffae8',
		highlight_font_color: '#800000',
		shadow_color: '#d98764'
	}
};
var theme = {};

// get config value or default
function getConfig(key) {
	var value =  localStorage.getItem('options.' + key);
	if (value != null)
		return typeof config[key] === 'number' ? Number(value) : value;
	else
		return (theme.hasOwnProperty(key) ? theme[key] : config[key]);
}

// set config value
function setConfig(key, value) {
	if (value != null)
		localStorage.setItem('options.' + key, typeof config[key] === 'number' ? Number(value) : value);
	else {
		localStorage.removeItem('options.' + key);
		value = (theme.hasOwnProperty(key) ? theme[key] : config[key]);
	}
	if (key.substring(0, 7) == 'weather')
			refreshWeather();
	else if (key == 'lock')
		loadColumns();
	else if (key == 'theme') {
		theme = themes[value];
		for (var i in config) {
			if (i != key) {
				onChange(i);
				showConfig(i);
			}
		}
	}
	onChange(key, value);
	return value;
}

// map config keys to styles
var styles = {};

function getStyle(key, value) {
	switch(key) {
		case 'font':
			return '#main a { font-family: "' + value + '"; }';
		case 'font_size':
			return '#main a { font-size: ' + (value / 10) + 'em; }';
		case 'font_color':
			return '#main a { color: ' + value + '; }' + 
				   '#options_font_color { background-color: ' + value + '; }' +
				   '#options_background_color { color: ' + value + '; }';
		case 'background_color':
			return 'body { background-color: ' + value + '; }' + 
				   '#options_font_color { color: ' + value + '; }' +
				   '#options_background_color { background-color: ' + value + '; }' +
				   '#options_shadow_color { color: ' + value + '; }';
		case 'background_image':
			return 'body { background-image: url(' + value + '); }';
		case 'background_align':
			return 'body { background-position: ' + value + '; }';
		case 'background_repeat':
			return 'body { background-repeat: ' + value + '; }';
		case 'highlight_font_color':
			return '#main a:hover { color: ' + value + '; }' + 
				   '#options_highlight_font_color { background-color: ' + value + '; }' +
				   '#options_highlight_color { color: ' + value + '; }';
		case 'highlight_color':
			return '#main a:hover { background-color: ' + value + '; }' + 
				   '#options_highlight_font_color { color: ' + value + '; }' +
				   '#options_highlight_color { background-color: ' + value + '; }';
		case 'shadow_color':
			return '#main a:hover { box-shadow: 0 0 ' + scale(getConfig('shadow_blur'), 7, 100) + 'px ' + value + '; }' + 
				   '#options_shadow_color { background-color: ' + value + '; }';
		case 'shadow_blur':
			return '#main a:hover { box-shadow: 0 0 ' + scale(value, 7, 100) + 'px ' + getConfig('shadow_color') + '; }';
		case 'highlight_round':
			return '#main a { border-radius: ' + scale(value, .2, 1.5) + 'em; }';
		case 'fade':
			return '#main a { -webkit-transition-duration: ' + scale(value, .2, 1) + 's; }';
		case 'slide':
			return '.wrap { -webkit-transition-duration: ' + scale(value, .2, 1) + 's; }';
		case 'spacing':
			return '#main a { line-height: ' + scale(value, 2, 5.6, .8) + '; } ' +
				   '#main a { border-left-width: ' + scale(value, .8, 2, .4) + 'em; }' +
				   '#main a { padding-right: ' + scale(value, .8, 2, .4) + 'em; }';
		case 'h_margin':
			return '#main { padding-left: ' + scale(value, 10, 40) + '%; } ' +
				   '#main { padding-right: ' + scale(value, 10, 40) + '%; }';
		case 'v_margin':
			return '#main { padding-top: ' + scale(value, 85, 340) + 'px; }';
		case 'hide_options':
			return '#options_button { opacity: 0; }';
		default:
			return null;
	}
}

// scales input value from [0,1,2] to [min,mid,max]
function scale(value, mid, max, min) {
	min = min || 0;
	return value > 1 ?
		mid + (value - 1) * (max - mid) :
		min + value * (mid - min);
}

// apply config value change
function onChange(key, value) {
	if (value == null)
		value = getConfig(key);

	if (value != config[key]) {
		var css = getStyle(key, value);
		if (css) {
			var style;
			if (styles.hasOwnProperty(key))
				style = styles[key];
			else {
				style = document.createElement('style');
				styles[key] = style;
			}
			document.head.appendChild(style);

			// add style rules
			style.innerText = css;	
		}
	} else if (styles.hasOwnProperty(key)) {
		// remove rules
		styles[key].parentNode.removeChild(styles[key]);
		delete styles[key];
	}

	// show/hide default button
	var isDefault = value == (theme.hasOwnProperty(key) ? theme[key] : config[key]);
	document.getElementById('options_' + key).nextSibling
		.style.visibility = (isDefault ? 'hidden' : null);
}

// apply config values to input controls
function showConfig(key) {
	var input = document.getElementById('options_' + key);
	input[input.type === 'checkbox' ? 'checked' : 'value'] = getConfig(key);
}

// initialize config settings
function initConfig(key) {
	var input = document.getElementById('options_' + key);
	input.onchange = function(event) {
		setConfig(key, input.type === 'checkbox' ? Number(input.checked) : input.value);
	};
	
	var button = document.createElement('button');
	button.innerText = 'Default';
	button.onclick = function() {
		setConfig(key, null);
		showConfig(key);
		return false;
	};
	
	input.parentNode.appendChild(button);
	onChange(key);
	showConfig(key);
}

// initialize settings
function initSettings() {
	// check if experimental enabled
	if (chrome.experimental) {
		// replace text input with system font list
		var input = document.getElementById('options_font');
		var select = document.createElement('select');
		input.parentNode.replaceChild(select, input);
		select.id = input.id;
	}

	// load theme
	theme = themes[getConfig('theme')] || {};

	// load settings
	for (var key in config)
		initConfig(key);
	
	// options menu
	var options = document.getElementById('options');
	document.getElementById('options_button').onclick = function() {
		for (var key in config)
			showConfig(key);
		
		return true;
	};

	// load themes
	var select = document.getElementById('options_theme');
	if (select.childNodes.length == 0) {
		for (var i in themes) {
			var option = document.createElement('option');
			option.innerText = i;
			if (i == getConfig('theme'))
				option.selected = 'selected';
			select.appendChild(option);
		}
	}

	// load font list
	if (chrome.experimental) {
		chrome.experimental.fontSettings.getFontList(function(fonts)  {
			var select = document.getElementById('options_font');
			if (select.childNodes.length > 0)
				return;

			fonts.unshift({ fontName: 'Sans-serif' });
			for (var i = 0; i < fonts.length; i++) {
				var font = fonts[i].fontName;
				var option = document.createElement('option');
				option.innerText = font;
				if (font == getConfig('font'))
					option.selected = 'selected';
				select.appendChild(option);
			}
		});
	}
}

// initialize page
function init() {
	initSettings();
	loadColumns();

	// refresh recently closed on tab close
	chrome.extension.onMessage.addListener(function(request, sender, sendResponse) {
		if (request == 'tab.closed')
			refreshClosed();
	});

	// fix scrollbar jump
	window.onresize = function(event) {
		document.body.style.width = window.innerWidth + 'px';
	}
	window.onresize();
}

document.addEventListener('DOMContentLoaded', init);
