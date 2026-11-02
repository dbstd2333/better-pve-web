// Summary pages as a responsive card grid.

BP.CARD_MIN_WIDTH = 520;

BP.cardify = function (container) {
    if (!container || container.bpCardified) {
        return;
    }
    container.bpCardified = true;
    container.addCls('bp-cards');
    // stock summaries force minWidth 700 and scroll sideways on narrow screens
    if (container.minWidth > 420) {
        container.setMinWidth(420);
    }
    var mark = function (item) {
        item.addCls('bp-card');
    };
    container.items.each(mark);
    container.on('add', function (_c, item) {
        mark(item);
    });
};

BP.feature('cards-columns', ['Proxmox.Utils'], function () {
    var orig = Proxmox.Utils.updateColumnWidth;

    // 'auto' mode: as many columns as fit CARD_MIN_WIDTH (max 4) instead of
    // one column per 1400px. An explicit user choice in My Settings wins.
    Proxmox.Utils.updateColumnWidth = function (container, thresholdWidth) {
        var mode = Ext.state.Manager.get('summarycolumns') || 'auto';
        if (mode !== 'auto' || !container.hasCls || !container.hasCls('bp-cards')) {
            return orig.apply(this, arguments);
        }
        var width = container.getSize().width;
        var all = container.query('>');
        var items = all.filter(function (item) {
            return !item.bpFullWidth && !item.isHidden();
        });
        var factor = Math.max(1, Math.min(4, Math.floor(width / BP.CARD_MIN_WIDTH)));
        factor = Math.max(1, Math.min(factor, items.length));
        if (container.oldFactor === factor) {
            return undefined;
        }
        container.oldFactor = factor;
        all.forEach(function (item) {
            item.columnWidth = item.bpFullWidth ? 1 : 1 / factor;
        });
        container.updateLayout();
        container.updateLayout();
        return undefined;
    };
    Proxmox.Utils.updateColumns = function (container) {
        return Proxmox.Utils.updateColumnWidth(container);
    };
});

BP.feature('cards-node', ['PVE.node.Summary'], function () {
    Ext.define(null, {
        override: 'PVE.node.Summary',
        initComponent: function () {
            this.callParent(arguments);
            var me = this;
            BP.safe(function () {
                BP.cardify(me.getComponent('itemcontainer'));
                // the status card has a fixed 770px width; let the column decide
                if (me.nodeStatus) {
                    me.nodeStatus.width = undefined;
                    me.nodeStatus.addCls('bp-card-status');
                }
            })();
        },
    });
});

BP.feature('cards-guest', ['PVE.guest.Summary'], function () {
    Ext.define(null, {
        override: 'PVE.guest.Summary',
        initComponent: function () {
            this.callParent(arguments);
            var me = this;
            BP.safe(function () {
                BP.cardify(me.getComponent('itemcontainer'));
            })();
        },
    });
});
