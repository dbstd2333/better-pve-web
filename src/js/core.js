// Shared helpers. Every feature module registers through BP.feature() so a
// missing PVE class or a runtime error only disables that one feature.

var BP = (window.BetterPVE = {
    version: BPVE_VERSION,
    features: {},
});

BP.log = function () {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[better-pve]');
    console.warn.apply(console, args);
};

BP.hasClass = function (name) {
    return !!(window.Ext && Ext.ClassManager.get(name));
};

// Run fn() if every required class exists; failures are logged, never thrown.
BP.feature = function (id, requires, fn) {
    var missing = requires.filter(function (c) {
        return !BP.hasClass(c);
    });
    if (missing.length) {
        BP.features[id] = 'skipped: ' + missing.join(', ');
        BP.log('feature', id, 'skipped, missing', missing.join(', '));
        return;
    }
    try {
        fn();
        BP.features[id] = 'ok';
    } catch (e) {
        BP.features[id] = 'error: ' + e;
        BP.log('feature', id, 'failed', e);
    }
};

// Guard a piece of render logic so a bug never breaks the host widget.
BP.safe = function (fn, fallback) {
    return function () {
        try {
            return fn.apply(this, arguments);
        } catch (e) {
            BP.log('render error', e);
            return typeof fallback === 'function' ? fallback.apply(this, arguments) : fallback;
        }
    };
};

BP.isZh = function () {
    var lang = (window.Proxmox && Proxmox.defaultLang) || navigator.language || '';
    return /^zh/i.test(lang);
};

// tiny i18n: BP.t('Network', '网络')
BP.t = function (en, zh) {
    return BP.isZh() ? zh : en;
};

BP.esc = function (s) {
    return Ext.String.htmlEncode(String(s));
};

BP.level = function (ratio, warn, crit) {
    if (ratio >= (crit || 0.9)) {
        return 'crit';
    }
    if (ratio >= (warn || 0.7)) {
        return 'warn';
    }
    return 'ok';
};

BP.fmtBytes = function (n, digits) {
    if (!Ext.isNumeric(n) || n < 0) {
        return '-';
    }
    var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return n.toFixed(i === 0 ? 0 : digits === undefined ? 1 : digits) + ' ' + units[i];
};

BP.fmtRate = function (bytesPerSec) {
    return BP.fmtBytes(bytesPerSec) + '/s';
};

BP.fmtPct = function (ratio) {
    return (ratio * 100).toFixed(ratio < 0.1 ? 1 : 0) + '%';
};

// Horizontal usage bar; ratio is 0..1.
BP.bar = function (ratio, opts) {
    opts = opts || {};
    ratio = Math.max(0, Math.min(1, ratio || 0));
    var lv = BP.level(ratio, opts.warn, opts.crit);
    var cls = 'bp-bar bp-lv-' + lv + (opts.cls ? ' ' + opts.cls : '');
    var qtip = opts.qtip ? ' data-qtip="' + BP.esc(opts.qtip) + '"' : '';
    var attrs = opts.attrs || '';
    return (
        '<span class="' + cls + '"' + qtip + ' ' + attrs + '>' +
        '<span class="bp-bar-fill" style="width:' + (ratio * 100).toFixed(1) + '%"></span>' +
        '</span>'
    );
};

// Track monotonic counters and turn them into per-second rates.
// key: unique series id; counters: {name: number}; ts: seconds.
BP.rateTracker = function () {
    var prev = {};
    return function (key, counters, ts) {
        var last = prev[key];
        prev[key] = { c: counters, ts: ts };
        if (!last || !(ts > last.ts)) {
            return null;
        }
        var dt = ts - last.ts;
        var out = {};
        Ext.Object.each(counters, function (name, val) {
            var before = last.c[name];
            if (!Ext.isNumeric(val) || !Ext.isNumeric(before) || val < before) {
                out[name] = null; // counter reset or missing
            } else {
                out[name] = (val - before) / dt;
            }
        });
        return out;
    };
};

BP.sum = function (obj, field) {
    var total = 0;
    var seen = false;
    Ext.Object.each(obj || {}, function (_k, v) {
        if (v && Ext.isNumeric(v[field])) {
            total += Number(v[field]);
            seen = true;
        }
    });
    return seen ? total : null;
};

BP.store = {
    get: function (key, def) {
        try {
            var v = window.localStorage.getItem('bpve-' + key);
            return v === null ? def : JSON.parse(v);
        } catch (e) {
            return def;
        }
    },
    set: function (key, value) {
        try {
            window.localStorage.setItem('bpve-' + key, JSON.stringify(value));
        } catch (e) {
            // storage unavailable: setting just won't persist
        }
    },
};

// Navigate the resource tree to a resource id like "qemu/100".
BP.select = function (id) {
    var tree = Ext.ComponentQuery.query('pveResourceTree')[0];
    if (tree && tree.selectById) {
        tree.selectById(id);
    }
};

document.documentElement.classList.add('bp-enabled');
