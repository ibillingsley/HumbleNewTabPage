/**
 * Theme definitions - shared between prevent-white-flash.js and newtab.js
 */

'use strict';

const themes = {
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

// Export for Node.js/Jest testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = themes;
}
