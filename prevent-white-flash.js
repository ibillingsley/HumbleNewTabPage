// Apply critical styles immediately to prevent white flash
// This runs before body renders, reading from localStorage
// Requires themes.js to be loaded first
(function() {
    const themeName = localStorage.getItem('options.theme');
    const theme = themes[themeName] || {};
    const bgColor = localStorage.getItem('options.background_color') || theme.background_color || '#ffffff';
    const fontColor = localStorage.getItem('options.font_color') || theme.font_color || '#555555';

    // Apply immediately via style element for fastest paint
    const style = document.createElement('style');
    style.id = 'early-styles';
    style.textContent = `body{background-color:${bgColor}}#main a{color:${fontColor}}`;
    document.head.appendChild(style);
})();
