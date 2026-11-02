// RRD charts: theme series palette, crisp lines with a soft area fill.

BP.feature('charts', ['Proxmox.widget.RRDChart'], function () {
    var palette = function () {
        var css = getComputedStyle(document.documentElement);
        var colors = [];
        for (var i = 1; i <= 6; i++) {
            var c = css.getPropertyValue('--bp-series-' + i).trim();
            if (c) {
                colors.push(c);
            }
        }
        return colors;
    };

    // stock charts hard-code some colors (memory, pressure stall); map them
    // onto the theme palette by role
    var STOCK = {
        '#94ae0a': '#3a4250', // memory total -> quiet slate
        '#115fa6': 1, // memory used
        '#c4c0c0': '#8b93a1', // host memory line
        '#24ad9a': 5, // ZFS ARC
        '#bbde0d': 2, // available
        '#ffd13e': 3, // pressure "some"
        '#a61120': 6, // pressure "full"
    };
    var remap = function (c) {
        var hit = STOCK[String(c).toLowerCase()];
        if (hit === undefined) {
            return c;
        }
        if (typeof hit === 'number') {
            return palette()[hit - 1] || c;
        }
        return hit;
    };

    Ext.define(null, {
        override: 'Proxmox.widget.RRDChart',

        // Colors go on each series: chart-level setColors() re-applies the
        // Ext theme and loses the dark legend/background.
        addSeries: function (series) {
            var me = this;
            BP.safe(function () {
                if (!me.bpColors) {
                    var stock = me.initialConfig && me.initialConfig.colors;
                    me.bpColors = stock ? stock.map(remap) : palette();
                    me.bpSeriesIndex = 0;
                }
                Ext.Array.from(series).forEach(function (s) {
                    if (!s || s.isSeries) {
                        return;
                    }
                    var color = me.bpColors[me.bpSeriesIndex++ % me.bpColors.length];
                    if (color && !s.colors) {
                        s.colors = [color];
                    }
                    if (s.type === 'line' && s.fill) {
                        s.style = Ext.apply({}, { lineWidth: 1.6, fillOpacity: 0.16, strokeOpacity: 1 }, s.style);
                        s.style.opacity = 1;
                    }
                });
            })();
            return this.callParent(arguments);
        },
    });
});
