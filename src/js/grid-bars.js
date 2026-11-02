// Resource grids (Datacenter/Pool/Search): percentage columns as colored
// bars. Only the ResourceStore column definitions are wrapped, the global
// PVE.Utils renderers stay untouched.

BP.feature('grid-bars', ['PVE.data.ResourceStore'], function () {
    var store = PVE.data.ResourceStore;
    if (typeof store.defaultColumns !== 'function') {
        throw 'defaultColumns not found';
    }

    var BAR_FIELDS = {
        cpu: true,
        memuse: true,
        diskuse: true,
        hostcpu: true,
        hostmemuse: true,
    };

    var withBar = function (orig) {
        return function () {
            var text = orig.apply(this, arguments);
            return BP.safe(function () {
                var m = /(\d+(?:\.\d+)?)\s*%/.exec(String(text || ''));
                if (!m) {
                    return text;
                }
                var ratio = parseFloat(m[1]) / 100;
                return (
                    '<div class="bp-cell-bar">' +
                    BP.bar(ratio) +
                    '<span class="bp-cell-bar-text">' + text + '</span>' +
                    '</div>'
                );
            }, text)();
        };
    };

    var origDefaultColumns = store.defaultColumns;
    store.defaultColumns = function () {
        var cols = origDefaultColumns.apply(this, arguments);
        cols.forEach(function (c) {
            if (BAR_FIELDS[c.dataIndex] && typeof c.renderer === 'function' && !c.bpWrapped) {
                c.renderer = withBar(c.renderer);
                c.bpWrapped = true;
                c.width = Math.max(c.width || 0, 140);
            }
        });
        return cols;
    };
});
