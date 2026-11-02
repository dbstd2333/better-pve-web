// VM / CT status card: live network and disk rates derived from the
// cumulative counters in status/current.

BP.feature('guest-rate', ['PVE.panel.GuestStatusView'], function () {
    var rate = BP.rateTracker();

    Ext.define(null, {
        override: 'PVE.panel.GuestStatusView',

        initComponent: function () {
            var me = this;
            var sel = me.pveSelNode && me.pveSelNode.data;
            var key = sel ? sel.id || sel.type + '/' + sel.vmid : 'guest';
            var items = Ext.Array.clone(me.items);

            var row = {
                itemId: 'bpGuestIO',
                printBar: false,
                iconCls: 'fa fa-fw fa-exchange',
                title: BP.t('Network / Disk', '网络 / 磁盘'),
                multiField: true,
                renderer: BP.safe(function (record) {
                    var d = record.data;
                    if (d.status !== 'running') {
                        return '<span class="bp-muted">-</span>';
                    }
                    var r = rate(key, {
                        netin: d.netin,
                        netout: d.netout,
                        read: d.diskread,
                        write: d.diskwrite,
                    }, Date.now() / 1000);
                    return (
                        BP.renderRatePair('↓', r && r.netin, '↑', r && r.netout) +
                        '<span class="bp-rate-gap"></span>' +
                        BP.renderRatePair('R', r && r.read, 'W', r && r.write)
                    );
                }, '-'),
            };

            var at = -1;
            for (var i = 0; i < items.length; i++) {
                if (items[i].itemId === 'rootfs') {
                    at = i;
                }
            }
            items.splice(at >= 0 ? at + 1 : items.length, 0, row);
            me.items = items;

            me.callParent(arguments);
        },
    });
});
