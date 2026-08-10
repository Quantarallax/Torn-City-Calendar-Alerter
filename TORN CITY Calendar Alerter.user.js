// ==UserScript==
// @name         TORN CITY Calendar Alerter
// @namespace    sanxion.tc.calendaralert
// @version      1.7.0
// @description  Reads the calendar API to show the player up and coming events.
// @author       Sanxion [2987640]
// @match        https://www.torn.com/*
// @updateURL    https://github.com/Quantarallax/Torn-City-Calendar-Alerter/raw/refs/heads/main/TORN%20CITY%20Calendar%20Alerter.user.js
// @downloadURL  https://github.com/Quantarallax/Torn-City-Calendar-Alerter/raw/refs/heads/main/TORN%20CITY%20Calendar%20Alerter.user.js
// @license      MIT
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

/*
 * Torn Calendar Alerter
 *
 * An embedded widget for Torn City that reads the Torn calendar API and
 * shows the next three events with the days remaining until each one, or
 * 'Event in progress.' while one is running. It can sit across the top of
 * the main page area or in the left sidebar, minimises to a single line,
 * and remembers its settings between visits.
 */

(function () {
    'use strict';

    var SCRIPT_VERSION = '1.7.0';
    var WIDGET_TITLE = 'Torn Calendar Alerter';
    var STORE_KEY = 'tcca_settings_v1';
    var API_REFRESH_MS = 15 * 60 * 1000;
    var TICK_MS = 60 * 1000;
    var WATCHDOG_MS = 2000;
    var DAY_MS = 24 * 60 * 60 * 1000;
    var WIDGET_ID = 'tcca-widget';
    var KEY_INPUT_ID = 'tcca-in-key';
    var KEY_STATUS_ID = 'tcca-key-status';
    var TIP_ID = 'tcca-tip';
    var TIP_AUDIT_MS = 400;
    var SCHEMES = ['default', 'torn', 'bw'];
    var SCHEME_LABELS = {
        default: 'Default',
        torn: 'Torn',
        bw: 'Black and White'
    };

    function log(message) {
        if (window.console && window.console.info) {
            window.console.info('[Torn Calendar Alerter] ' + message);
        }
    }

    var DEFAULT_SETTINGS = {
        apiKeyEnc: '',
        position: 'Top',
        minimised: true,
        scheme: 'bw',
        redMax: 3,
        yellowMax: 6,
        settingsOpen: false
    };

    var state = {
        settings: Object.assign({}, DEFAULT_SETTINGS),
        apiKey: '',
        events: [],
        fetchError: '',
        keyStatus: '',
        hovering: false,
        tipAnchor: null,
        lastFetch: 0
    };

    var OBF_SALT = 'tcca-sanxion';

    function xorText(text) {
        var out = '';
        var i = 0;
        while (i < text.length) {
            out += String.fromCharCode(
                text.charCodeAt(i) ^ OBF_SALT.charCodeAt(i % OBF_SALT.length)
            );
            i += 1;
        }
        return out;
    }

    function safeAtob(text) {
        try {
            return { ok: true, value: window.atob(text) };
        } catch (e) {
            return { ok: false, value: '', reason: e.message };
        }
    }

    function obfuscate(plain) {
        return plain ? window.btoa(xorText(plain)) : '';
    }

    function deobfuscate(stored) {
        if (!stored) {
            return '';
        }
        var decoded = safeAtob(stored);
        return decoded.ok ? xorText(decoded.value) : '';
    }

    function maskKey(plain) {
        if (!plain) {
            return 'none';
        }
        if (plain.length <= 4) {
            return '\u2022\u2022\u2022\u2022';
        }
        return '\u2022\u2022\u2022\u2022' + plain.slice(-4);
    }

    function safeParse(raw) {
        try {
            return JSON.parse(raw);
        } catch (e) {
            return { parseError: e.message };
        }
    }

    function loadSettings() {
        var raw = GM_getValue(STORE_KEY, '');
        var parsed = raw ? safeParse(raw) : {};
        var out = Object.assign({}, DEFAULT_SETTINGS);
        Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
            if (Object.prototype.hasOwnProperty.call(parsed, k)) {
                out[k] = parsed[k];
            }
        });

        if (!out.apiKeyEnc && parsed.apiKey) {
            out.apiKeyEnc = obfuscate(String(parsed.apiKey));
        }
        return out;
    }

    function saveSettings() {
        GM_setValue(STORE_KEY, JSON.stringify(state.settings));
    }

    var CSS_RULES = [
        '#tcca-widget { box-sizing: border-box; font-family: Arial, Helvetica, sans-serif;',
        '  font-size: 12px; border-radius: 5px; position: relative; margin: 6px 0;',
        '  box-shadow: 0 1px 3px rgba(0,0,0,0.4); z-index: 100; }',
        '#tcca-widget * { box-sizing: border-box; }',
        '#tcca-widget a { text-decoration: underline; }',

        '.tcca-header { display: flex; align-items: center; padding: 5px 8px;',
        '  border-radius: 5px 5px 0 0; }',
        '.tcca-min .tcca-header { border-radius: 5px; }',
        '.tcca-title { font-weight: bold; margin-right: 8px; white-space: nowrap; }',
        '.tcca-summary { flex: 1; overflow: hidden; text-overflow: ellipsis;',
        '  white-space: nowrap; opacity: 0.95; }',
        '.tcca-btn { border: 1px solid transparent; background: transparent; color: inherit;',
        '  cursor: pointer; font-size: 13px; line-height: 1; padding: 2px 6px; margin-left: 4px;',
        '  border-radius: 3px; }',
        '.tcca-btn:hover { filter: brightness(1.35); }',
        '.tcca-btn:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }',
        '.tcca-actions { display: flex; align-items: center; flex: 0 0 auto; margin-left: auto; }',

        '.tcca-pos-left .tcca-header { flex-wrap: wrap; padding: 4px 6px; }',
        '.tcca-pos-left .tcca-title { flex: 1 1 auto; min-width: 0; margin-right: 4px;',
        '  overflow: hidden; text-overflow: ellipsis; font-size: 11px; }',
        '.tcca-pos-left .tcca-summary { order: 3; flex: 1 1 100%; margin-top: 3px;',
        '  white-space: normal; }',
        '.tcca-pos-left .tcca-btn { padding: 2px 4px; margin-left: 2px; }',

        '.tcca-body { padding: 6px 8px; border-radius: 0 0 5px 5px; }',
        '.tcca-pos-top .tcca-body { display: flex; flex-direction: row; gap: 8px;',
        '  min-height: 100px; align-items: stretch; }',
        '.tcca-pos-left .tcca-body { display: flex; flex-direction: column; gap: 6px; }',
        '.tcca-event { border-radius: 4px; padding: 6px 8px; flex: 1 1 0; min-width: 0; }',
        '.tcca-event-title { font-weight: bold; margin-bottom: 3px; overflow: hidden;',
        '  text-overflow: ellipsis; white-space: nowrap; }',
        '.tcca-event-meta { display: flex; justify-content: space-between; gap: 6px;',
        '  align-items: baseline; flex-wrap: wrap; }',
        '.tcca-event-start { opacity: 0.95; }',
        '.tcca-badge { font-weight: bold; white-space: nowrap; }',
        '.tcca-msg { padding: 4px 2px; }',

        '.tcca-hl-red { background: #a32020; color: #ffffff; }',
        '.tcca-hl-yellow { background: #d8c24a; color: #1c1c1c; }',
        '.tcca-hl-green { background: #2e7d32; color: #ffffff; }',

        '.tcca-settings { padding: 8px; border-radius: 0 0 5px 5px; }',
        '.tcca-settings.tcca-overlay { position: absolute; top: 0; left: 0; z-index: 999999;',
        '  min-width: 300px; border-radius: 5px; box-shadow: 0 2px 8px rgba(0,0,0,0.6); }',
        '.tcca-row { display: flex; align-items: center; justify-content: space-between;',
        '  gap: 8px; margin-bottom: 6px; }',
        '.tcca-row label { white-space: nowrap; }',
        '.tcca-row input, .tcca-row select { padding: 2px 4px; border-radius: 3px;',
        '  border: 1px solid #666666; font-size: 12px; }',
        '.tcca-row input[type="number"] { width: 56px; }',
        '.tcca-row input[type="password"] { flex: 1; min-width: 0; }',
        '.tcca-settings .tcca-action { border: 1px solid #666666; cursor: pointer;',
        '  background: rgba(255,255,255,0.12); color: inherit; padding: 3px 8px;',
        '  border-radius: 3px; font-size: 12px; }',
        '.tcca-settings .tcca-action:hover { filter: brightness(1.25); }',
        '.tcca-info { margin: 6px 0; opacity: 0.95; }',
        '.tcca-note { margin: -2px 0 6px 0; font-size: 11px; opacity: 0.85; line-height: 1.4; }',
        '.tcca-status { margin: -2px 0 8px 0; font-size: 11px; line-height: 1.4; min-height: 14px; }',
        '.tcca-status-ok { color: #6ede8a; }',
        '.tcca-status-bad { color: #ff9c8a; }',
        '.tcca-status-busy { opacity: 0.8; }',
        '.tcca-credits { margin-top: 6px; padding-top: 6px;',
        '  border-top: 1px solid rgba(255,255,255,0.25); }',
        '.tcca-version { margin-top: 4px; opacity: 0.85; }',

        '.tcca-scheme-default { background: #22303f; color: #e8eef4; border: 1px solid #3d5064; }',
        '.tcca-scheme-default .tcca-header { background: linear-gradient(#33465a, #263646); }',
        '.tcca-scheme-default .tcca-settings { background: #22303f; }',
        '.tcca-scheme-default a { color: #8fc1e8; }',
        '.tcca-scheme-default .tcca-row input,',
        '.tcca-scheme-default .tcca-row select { background: #16202b; color: #e8eef4;',
        '  border-color: #3d5064; }',

        '.tcca-scheme-torn { background: #444444; color: #ffffff; border: 1px solid #7a7a7a; }',
        '.tcca-scheme-torn .tcca-header { background: linear-gradient(#5a5a5a, #3f3f3f);',
        '  color: #ffffff; }',
        '.tcca-scheme-torn .tcca-settings { background: #444444; color: #ffffff; }',
        '.tcca-scheme-torn a { color: #dcdcdc; }',
        '.tcca-scheme-torn .tcca-event-start { color: #d0d0d0; }',
        '.tcca-scheme-torn .tcca-row input,',
        '.tcca-scheme-torn .tcca-row select { background: #3a3a3a; color: #ffffff;',
        '  border-color: #8a8a8a; }',

        '.tcca-scheme-bw { background: #000000; color: #ffffff; border: 1px solid #ffffff; }',
        '.tcca-scheme-bw .tcca-header { background: #111111; color: #ffffff; }',
        '.tcca-scheme-bw .tcca-settings { background: #000000; color: #ffffff; }',
        '.tcca-scheme-bw a { color: #ffffff; }',
        '.tcca-scheme-bw .tcca-status-ok { color: #ffffff; font-weight: bold; }',
        '.tcca-scheme-bw .tcca-status-bad { color: #ffffff; text-decoration: underline; }',
        '.tcca-scheme-bw .tcca-row input,',
        '.tcca-scheme-bw .tcca-row select { background: #111111; color: #ffffff;',
        '  border-color: #ffffff; }',

        '#tcca-tip { position: fixed; top: 0; left: 0; z-index: 2147483647;',
        '  max-width: 320px; padding: 6px 9px; border-radius: 4px; pointer-events: none;',
        '  font: 12px/1.45 Arial, Helvetica, sans-serif; white-space: pre-line;',
        '  box-shadow: 0 2px 8px rgba(0,0,0,0.55); visibility: hidden; opacity: 0; }',
        '#tcca-tip.tcca-tip-on { visibility: visible; opacity: 1; }',
        '#tcca-tip .tcca-tip-head { font-weight: bold; }',

        '.tcca-fixed-top { position: fixed; top: 0; left: 0; right: 0; z-index: 999998;',
        '  margin: 0; border-radius: 0; }',
        '.tcca-fixed-left { position: fixed; top: 60px; left: 0; width: 200px;',
        '  z-index: 999998; margin: 0; }'
    ].join('\n');

    function injectStyles() {
        if (document.getElementById('tcca-styles') || !document.head) {
            return;
        }
        var styleEl = document.createElement('style');
        styleEl.id = 'tcca-styles';
        styleEl.textContent = CSS_RULES;
        document.head.appendChild(styleEl);
    }

    function calendarUrl(key) {
        return 'https://api.torn.com/v2/torn/calendar?key=' + encodeURIComponent(key);
    }

    function fetchCalendar() {
        state.lastFetch = Date.now();
        if (!state.apiKey) {
            state.fetchError = 'No API key set. Click the cog to add one.';
            state.events = [];
            render();
            return;
        }
        fetch(calendarUrl(state.apiKey))
            .then(function (resp) {
                return resp.json();
            })
            .then(function (data) {
                if (data && data.error) {
                    state.fetchError = 'API error: ' + data.error.error;
                    state.events = [];
                } else {
                    state.events = normaliseCalendar(data);
                    state.fetchError = '';
                }
                render();
            })
            .catch(function (err) {
                state.fetchError = 'Could not reach the API: ' + err.message;
                render();
            });
    }

    function normaliseCalendar(data) {
        var merged = [];
        var cal = (data && data.calendar) ? data.calendar : {};
        ['events', 'competitions'].forEach(function (key) {
            var list = cal[key];
            if (!Array.isArray(list)) {
                return;
            }
            list.forEach(function (item) {
                var start = Number(item.start);
                var end = Number(item.end);
                if (!Number.isFinite(start)) {
                    return;
                }
                merged.push({
                    title: String(item.title || 'Untitled event'),
                    description: stripHtml(String(item.description || '')),
                    start: start,
                    end: Number.isFinite(end) ? end : start
                });
            });
        });
        var now = Date.now();
        var upcoming = merged.filter(function (ev) {
            return (ev.end * 1000) >= now;
        });
        upcoming.sort(function (a, b) {
            return a.start - b.start;
        });
        return upcoming;
    }

    function stripHtml(text) {
        return text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    }

    function pad(n) {
        return n < 10 ? '0' + n : String(n);
    }

    function formatTct(epochSeconds) {
        var d = new Date(epochSeconds * 1000);
        var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
            'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return dayNames[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' +
            monthNames[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ' ' +
            pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' TCT';
    }

    function formatLocal(epochSeconds) {
        return new Date(epochSeconds * 1000).toLocaleString();
    }

    function isInProgress(ev) {
        var now = Date.now();
        return (ev.start * 1000) <= now && (ev.end * 1000) >= now;
    }

    function daysUntil(ev) {
        return Math.ceil(((ev.start * 1000) - Date.now()) / DAY_MS);
    }

    function highlightClass(days) {
        var red = Number(state.settings.redMax);
        var yellow = Number(state.settings.yellowMax);
        if (!Number.isFinite(red)) {
            red = DEFAULT_SETTINGS.redMax;
        }
        if (!Number.isFinite(yellow)) {
            yellow = DEFAULT_SETTINGS.yellowMax;
        }
        if (days <= red) {
            return 'tcca-hl-red';
        }
        if (days <= yellow) {
            return 'tcca-hl-yellow';
        }
        return 'tcca-hl-green';
    }

    function badgeText(ev) {
        if (isInProgress(ev)) {
            return 'Event in progress.';
        }
        var days = daysUntil(ev);
        return days + (days === 1 ? ' day' : ' days');
    }

    function summaryText(ev) {
        if (state.settings.position === 'Left') {
            return ev.title + ': ' + badgeText(ev);
        }
        if (isInProgress(ev)) {
            return ev.title + ' \u2014 Event in progress.';
        }
        return 'Next: ' + ev.title + ' \u2014 ' + badgeText(ev);
    }

    function eventTooltip(ev) {
        var lines = [ev.title];
        if (ev.description) {
            lines.push(ev.description);
        }
        lines.push('Starts: ' + formatTct(ev.start) + ' (local: ' + formatLocal(ev.start) + ')');
        lines.push('Ends: ' + formatTct(ev.end) + ' (local: ' + formatLocal(ev.end) + ')');
        if (isInProgress(ev)) {
            lines.push('Event in progress.');
        } else {
            lines.push('Days to event: ' + daysUntil(ev));
        }
        return lines.join('\n');
    }

    function setTip(el, text) {
        if (text) {
            el.dataset.tccaTip = text;
        }
        return el;
    }

    function getTipEl() {
        var el = document.getElementById(TIP_ID);
        if (el) {
            return el;
        }
        if (!document.body) {
            return null;
        }
        el = document.createElement('div');
        el.id = TIP_ID;
        el.setAttribute('role', 'tooltip');
        document.body.appendChild(el);
        return el;
    }

    function hideTip() {
        state.tipAnchor = null;
        var el = document.getElementById(TIP_ID);
        if (el) {
            el.classList.remove('tcca-tip-on');
        }
    }

    function tipVisible() {
        var el = document.getElementById(TIP_ID);
        return !!el && el.classList.contains('tcca-tip-on');
    }

    function placeTip(el, x, y) {
        var gap = 16;
        var box = el.getBoundingClientRect();
        var left = x + gap;
        var top = y + gap;
        if (left + box.width > window.innerWidth - 8) {
            left = Math.max(8, x - gap - box.width);
        }
        if (top + box.height > window.innerHeight - 8) {
            top = Math.max(8, y - gap - box.height);
        }
        el.style.left = Math.round(left) + 'px';
        el.style.top = Math.round(top) + 'px';
    }

    function showTip(text, x, y) {
        var el = getTipEl();
        if (!el) {
            return;
        }
        el.textContent = text;
        el.className = 'tcca-scheme-' + state.settings.scheme + ' tcca-tip-on';
        placeTip(el, x, y);
    }

    function tipTargetOf(node) {
        if (!node || !node.closest) {
            return null;
        }
        return node.closest('[data-tcca-tip]');
    }

    function onTipMove(ev) {
        var widget = getWidget();
        var target = tipTargetOf(ev.target);
        state.hovering = !!widget && widget.contains(ev.target);
        if (!widget || !target || !widget.contains(target)) {
            hideTip();
            return;
        }
        state.tipAnchor = target;
        showTip(target.dataset.tccaTip, ev.clientX, ev.clientY);
    }

    function auditTip() {
        if (!tipVisible()) {
            return;
        }
        var anchor = state.tipAnchor;
        var widget = getWidget();
        if (!anchor || !anchor.isConnected || !widget || !widget.contains(anchor)) {
            hideTip();
        }
    }

    var tipHandlersBound = false;

    function bindTooltips() {
        if (tipHandlersBound) {
            return;
        }
        tipHandlersBound = true;
        document.addEventListener('mousemove', onTipMove, true);
        document.addEventListener('mousedown', hideTip, true);
        document.addEventListener('click', hideTip, true);
        document.addEventListener('keydown', hideTip, true);
        document.addEventListener('mouseleave', hideTip);
        document.addEventListener('visibilitychange', hideTip);
        window.addEventListener('scroll', hideTip, true);
        window.addEventListener('resize', hideTip);
        window.addEventListener('blur', hideTip);
        setInterval(auditTip, TIP_AUDIT_MS);
    }

    function getWidget() {
        return document.getElementById(WIDGET_ID);
    }

    function applyClasses(widget) {
        SCHEMES.forEach(function (s) {
            widget.classList.remove('tcca-scheme-' + s);
        });
        widget.classList.add('tcca-scheme-' + state.settings.scheme);
        widget.classList.remove('tcca-pos-top');
        widget.classList.remove('tcca-pos-left');
        widget.classList.add(state.settings.position === 'Left' ? 'tcca-pos-left' : 'tcca-pos-top');
        widget.classList.toggle('tcca-min', state.settings.minimised === true);
    }

    function render() {
        var widget = getWidget();
        if (!widget) {
            return;
        }
        hideTip();
        applyClasses(widget);
        while (widget.firstChild) {
            widget.removeChild(widget.firstChild);
        }
        widget.appendChild(buildHeader());
        if (!state.settings.minimised) {
            widget.appendChild(buildBody());
        }
        if (state.settings.settingsOpen) {
            widget.appendChild(buildSettings(widget));
        }
    }

    function buildHeader() {
        var header = document.createElement('div');
        header.className = 'tcca-header';
        setTip(header, WIDGET_TITLE + ' \u2014 the next events from the Torn calendar.');

        var title = document.createElement('span');
        title.className = 'tcca-title';
        title.textContent = WIDGET_TITLE;
        header.appendChild(title);

        var summary = document.createElement('span');
        summary.className = 'tcca-summary';
        if (state.settings.minimised) {
            var next = state.events.length ? state.events[0] : null;
            if (state.fetchError) {
                summary.textContent = state.fetchError;
                setTip(summary, state.fetchError);
            } else if (next) {
                summary.textContent = summaryText(next);
                setTip(summary, eventTooltip(next));
            } else {
                summary.textContent = 'No upcoming events.';
            }
        }
        header.appendChild(summary);

        var minBtn = document.createElement('button');
        minBtn.className = 'tcca-btn';
        minBtn.type = 'button';
        minBtn.textContent = state.settings.minimised ? '+' : '\u2013';
        setTip(minBtn, state.settings.minimised ? 'Expand the widget' : 'Minimise the widget');
        minBtn.addEventListener('click', function () {
            state.settings.minimised = !state.settings.minimised;
            saveSettings();
            render();
        });

        var actions = document.createElement('span');
        actions.className = 'tcca-actions';
        actions.appendChild(minBtn);
        header.appendChild(actions);

        var cogBtn = document.createElement('button');
        cogBtn.className = 'tcca-btn';
        cogBtn.type = 'button';
        cogBtn.textContent = '\u2699';
        setTip(cogBtn, 'Open settings');
        cogBtn.addEventListener('click', function () {
            state.settings.settingsOpen = !state.settings.settingsOpen;
            saveSettings();
            render();
        });
        actions.appendChild(cogBtn);

        return header;
    }

    function buildBody() {
        var body = document.createElement('div');
        body.className = 'tcca-body';

        if (state.fetchError) {
            var msg = document.createElement('div');
            msg.className = 'tcca-msg';
            msg.textContent = state.fetchError;
            setTip(msg, state.fetchError);
            body.appendChild(msg);
            return body;
        }

        if (!state.events.length) {
            var empty = document.createElement('div');
            empty.className = 'tcca-msg';
            empty.textContent = 'No upcoming events found.';
            body.appendChild(empty);
            return body;
        }

        state.events.slice(0, 3).forEach(function (ev) {
            var row = document.createElement('div');
            row.className = 'tcca-event';
            row.classList.add(isInProgress(ev) ? 'tcca-hl-red' : highlightClass(daysUntil(ev)));
            setTip(row, eventTooltip(ev));

            var titleEl = document.createElement('div');
            titleEl.className = 'tcca-event-title';
            titleEl.textContent = ev.title;
            setTip(titleEl, ev.description || String(ev.title));
            row.appendChild(titleEl);

            var meta = document.createElement('div');
            meta.className = 'tcca-event-meta';

            var startEl = document.createElement('span');
            startEl.className = 'tcca-event-start';
            startEl.textContent = formatTct(ev.start);
            setTip(startEl, 'Start time (local): ' + formatLocal(ev.start));
            meta.appendChild(startEl);

            var badge = document.createElement('span');
            badge.className = 'tcca-badge';
            badge.textContent = badgeText(ev);
            setTip(badge, eventTooltip(ev));
            meta.appendChild(badge);

            row.appendChild(meta);
            body.appendChild(row);
        });

        return body;
    }

    function setKeyStatus(text, kind) {
        state.keyStatus = text;
        var el = document.getElementById(KEY_STATUS_ID);
        if (!el) {
            return;
        }
        el.textContent = text;
        el.className = 'tcca-status' + (kind ? ' tcca-status-' + kind : '');
    }

    function commitApiKey(rawValue) {
        var key = rawValue.trim();
        if (key === state.apiKey) {
            return;
        }

        state.apiKey = key;
        state.settings.apiKeyEnc = obfuscate(key);
        saveSettings();

        if (!key) {
            setKeyStatus('Key cleared.', '');
            state.events = [];
            state.fetchError = 'No API key set. Click the cog to add one.';
            return;
        }

        setKeyStatus('Saved as ' + maskKey(key) + '. Testing the connection\u2026', 'busy');

        fetch(calendarUrl(key))
            .then(function (resp) {
                return resp.json();
            })
            .then(function (data) {
                if (data && data.error) {
                    setKeyStatus('Test failed: ' + data.error.error, 'bad');
                    state.fetchError = 'API error: ' + data.error.error;
                    state.events = [];
                    return;
                }
                var events = normaliseCalendar(data);
                state.events = events;
                state.fetchError = '';
                state.lastFetch = Date.now();
                setKeyStatus('Connected. ' + events.length + ' upcoming events found.', 'ok');
                refreshWidgetOnly();
            })
            .catch(function (err) {
                setKeyStatus('Test failed: ' + err.message, 'bad');
                state.fetchError = 'Could not reach the API: ' + err.message;
            });
    }

    function refreshWidgetOnly() {
        var widget = getWidget();
        if (!widget) {
            return;
        }
        hideTip();
        var oldHeader = widget.querySelector('.tcca-header');
        if (oldHeader) {
            widget.replaceChild(buildHeader(), oldHeader);
        }
        var oldBody = widget.querySelector('.tcca-body');
        if (oldBody && !state.settings.minimised) {
            widget.replaceChild(buildBody(), oldBody);
        }
    }

    function buildKeyRow() {
        var input = document.createElement('input');
        input.type = 'password';
        input.id = KEY_INPUT_ID;
        input.value = state.apiKey;
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.placeholder = 'Paste your key';
        setTip(input, 'Your Torn API key. Public Only access is enough. ' +
            'It saves and tests itself when you leave the field.');
        input.addEventListener('change', function () {
            commitApiKey(input.value);
        });
        input.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                commitApiKey(input.value);
            }
        });
        return makeRow('API key:', input);
    }

    function buildSettings(widget) {
        var panel = document.createElement('div');
        panel.className = 'tcca-settings';

        if (widget.offsetWidth > 0 && widget.offsetWidth < 320) {
            panel.classList.add('tcca-overlay');
        }

        var info = document.createElement('div');
        info.className = 'tcca-info';
        info.textContent = 'This script reads the calendar API to show the player up and coming events.';
        panel.appendChild(info);

        panel.appendChild(buildKeyRow());

        var keyNote = document.createElement('div');
        keyNote.className = 'tcca-note';
        keyNote.textContent = 'Used for one call, torn/calendar, to read the public event list. ' +
            'Public Only access is enough. The key saves and tests itself as soon as you ' +
            'leave the field, so Save settings is only for everything below. It is scrambled ' +
            'and kept on this device in Tampermonkey\u2019s storage, and is sent nowhere ' +
            'except api.torn.com.';
        panel.appendChild(keyNote);

        var status = document.createElement('div');
        status.id = KEY_STATUS_ID;
        status.className = 'tcca-status';
        if (state.keyStatus) {
            status.textContent = state.keyStatus;
        } else if (state.apiKey) {
            status.textContent = 'Key stored: ' + maskKey(state.apiKey) + '.';
        }
        panel.appendChild(status);

        panel.appendChild(makeRow('Red up to (days):', makeInput('number', 'tcca-in-red',
            state.settings.redMax,
            'Events this many days away or fewer are highlighted red.')));
        panel.appendChild(makeRow('Yellow up to (days):', makeInput('number', 'tcca-in-yellow',
            state.settings.yellowMax,
            'Events this many days away or fewer, but above the red limit, are yellow. Anything further out is green.')));

        var posSelect = document.createElement('select');
        posSelect.id = 'tcca-in-pos';
        setTip(posSelect, 'Where the widget sits on the page.');
        ['Left', 'Top'].forEach(function (opt) {
            var o = document.createElement('option');
            o.value = opt;
            o.textContent = opt;
            o.selected = state.settings.position === opt;
            posSelect.appendChild(o);
        });
        panel.appendChild(makeRow('Position:', posSelect));

        var schemeBtn = document.createElement('button');
        schemeBtn.className = 'tcca-action';
        schemeBtn.type = 'button';
        schemeBtn.textContent = SCHEME_LABELS[state.settings.scheme];
        setTip(schemeBtn, 'Cycle through the colour schemes.');
        schemeBtn.addEventListener('click', function () {
            var idx = SCHEMES.indexOf(state.settings.scheme);
            state.settings.scheme = SCHEMES[(idx + 1) % SCHEMES.length];
            saveSettings();
            render();
        });
        panel.appendChild(makeRow('Colour scheme:', schemeBtn));

        var saveBtn = document.createElement('button');
        saveBtn.className = 'tcca-action';
        saveBtn.type = 'button';
        saveBtn.textContent = 'Save settings';
        setTip(saveBtn, 'Save the settings above. The API key saves itself.');
        saveBtn.addEventListener('click', onSave);
        panel.appendChild(makeRow('', saveBtn));

        var credits = document.createElement('div');
        credits.className = 'tcca-credits';
        credits.appendChild(makeLink('https://www.torn.com/profiles.php?XID=2987640',
            'Written by Sanxion [2987640]', 'Open Sanxion\u2019s Torn City profile.'));
        credits.appendChild(makeLink('https://greasyfork.org/en/users/1593713-quantarallax?sort=total_installs',
            'Sanxion\u2019s Other Scripts', 'More scripts by Sanxion on Greasy Fork.'));

        var versionLine = document.createElement('div');
        versionLine.className = 'tcca-version';
        versionLine.textContent = 'Version ' + SCRIPT_VERSION;
        credits.appendChild(versionLine);

        panel.appendChild(credits);
        return panel;
    }

    function onSave() {
        var keyEl = document.getElementById(KEY_INPUT_ID);
        var redEl = document.getElementById('tcca-in-red');
        var yellowEl = document.getElementById('tcca-in-yellow');
        var posEl = document.getElementById('tcca-in-pos');
        var oldPos = state.settings.position;

        if (keyEl && keyEl.value.trim() !== state.apiKey) {
            commitApiKey(keyEl.value);
        }
        if (redEl) {
            state.settings.redMax = clampInt(redEl.value, 0, 365, DEFAULT_SETTINGS.redMax);
        }
        if (yellowEl) {
            state.settings.yellowMax = clampInt(yellowEl.value, 0, 365, DEFAULT_SETTINGS.yellowMax);
        }
        if (posEl) {
            state.settings.position = posEl.value;
        }
        state.settings.settingsOpen = false;
        saveSettings();

        if (state.settings.position !== oldPos) {
            remount();
        } else {
            render();
        }
    }

    function makeRow(labelText, control) {
        var row = document.createElement('div');
        row.className = 'tcca-row';
        var label = document.createElement('label');
        label.textContent = labelText;
        if (control.id) {
            label.htmlFor = control.id;
        }
        row.appendChild(label);
        row.appendChild(control);
        return row;
    }

    function makeInput(type, id, value, tooltip) {
        var input = document.createElement('input');
        input.type = type;
        input.id = id;
        input.value = String(value);
        setTip(input, tooltip);
        if (type === 'number') {
            input.min = '0';
            input.max = '365';
        }
        return input;
    }

    function makeLink(href, text, tooltip) {
        var line = document.createElement('div');
        var link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = text;
        setTip(link, tooltip);
        line.appendChild(link);
        return line;
    }

    function clampInt(value, min, max, fallback) {
        var n = parseInt(value, 10);
        if (!Number.isFinite(n)) {
            return fallback;
        }
        if (n < min) {
            return min;
        }
        if (n > max) {
            return max;
        }
        return n;
    }

    function findHost() {
        if (state.settings.position === 'Left') {
            return document.getElementById('sidebarroot') ||
                document.getElementById('sidebar') ||
                document.querySelector('[class^="sidebar_"]') ||
                document.querySelector('[class*="sidebar"]');
        }
        return document.querySelector('.content-wrapper') ||
            document.querySelector('[class*="content-wrapper"]') ||
            document.getElementById('mainContainer') ||
            document.querySelector('#react-root');
    }

    function mount() {
        if (getWidget()) {
            return true;
        }
        injectStyles();

        var widget = document.createElement('div');
        widget.id = WIDGET_ID;
        var host = findHost();

        if (host && state.settings.position === 'Left') {
            var logo = host.firstElementChild;
            if (logo && logo.nextSibling) {
                host.insertBefore(widget, logo.nextSibling);
            } else {
                host.appendChild(widget);
            }
        } else if (host) {
            host.insertBefore(widget, host.firstChild);
        } else if (document.body) {
            widget.classList.add(state.settings.position === 'Left'
                ? 'tcca-fixed-left'
                : 'tcca-fixed-top');
            document.body.appendChild(widget);
            log('No Torn container matched, so the widget is pinned to the page instead.');
        } else {
            return false;
        }

        render();
        return true;
    }

    function remount() {
        hideTip();
        var widget = getWidget();
        if (widget && widget.parentNode) {
            widget.parentNode.removeChild(widget);
        }
        mount();
    }

    var SC_PROJECT = '13341844';
    var SC_SECURITY = '464b0670';

    function fireStatCounter() {
        if (!document.body) {
            return;
        }
        var img = document.createElement('img');
        img.src = 'https://c.statcounter.com/' + SC_PROJECT + '/0/' + SC_SECURITY + '/1/';
        img.alt = '';
        img.width = 1;
        img.height = 1;
        img.style.position = 'absolute';
        img.style.left = '-9999px';
        img.referrerPolicy = 'no-referrer-when-downgrade';
        document.body.appendChild(img);
    }

    log('v' + SCRIPT_VERSION + ' starting.');
    state.settings = loadSettings();
    state.apiKey = deobfuscate(state.settings.apiKeyEnc);
    injectStyles();
    bindTooltips();
    mount();
    log(getWidget() ? 'Widget mounted.' : 'Widget could not mount yet, retrying.');

    setInterval(mount, WATCHDOG_MS);

    fetchCalendar();

    setInterval(function () {
        if (Date.now() - state.lastFetch >= API_REFRESH_MS) {
            fetchCalendar();
        } else if (!state.hovering) {
            render();
        }
    }, TICK_MS);

    if (document.readyState === 'complete') {
        fireStatCounter();
    } else {
        window.addEventListener('load', fireStatCounter, { once: true });
    }
})();
