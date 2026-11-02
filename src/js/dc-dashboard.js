// Datacenter summary: KPI strip + top consumers on top of the stock panels,
// cards layout, subscription panel hidden. All data comes from the already
// polled PVE.data.ResourceStore, no extra API calls.

BP.dashboardModel = function (records) {
    var m = {
        nodes: { online: 0, total: 0 },
        qemu: { running: 0, total: 0 },
        lxc: { running: 0, total: 0 },
        cpu: { used: 0, max: 0 },
        mem: { used: 0, max: 0 },
        disk: { used: 0, max: 0 },
        guests: [],
    };
    var seenShared = {};
    records.forEach(function (rec) {
        var d = rec.data;
        switch (d.type) {
            case 'node':
                m.nodes.total++;
                if (d.status === 'online') {
                    m.nodes.online++;
                    m.cpu.used += (d.cpu || 0) * (d.maxcpu || 0);
                    m.cpu.max += d.maxcpu || 0;
                    m.mem.used += d.mem || 0;
                    m.mem.max += d.maxmem || 0;
                }
                break;
            case 'qemu':
            case 'lxc':
                if (d.template) {
                    break;
                }
                m[d.type].total++;
                if (d.status === 'running') {
                    m[d.type].running++;
                    m.guests.push(d);
                }
                break;
            case 'storage': {
                if (d.status !== 'available') {
                    break;
                }
                var key = d.shared ? d.storage : d.id;
                if (seenShared[key]) {
                    break;
                }
                seenShared[key] = true;
                m.disk.used += d.disk || 0;
                m.disk.max += d.maxdisk || 0;
                break;
            }
            default:
                break;
        }
    });
    return m;
};

BP.renderDashboard = function (m) {
    var kpi = function (icon, label, value, sub, ratio) {
        return (
            '<div class="bp-kpi">' +
            '<div class="bp-kpi-head"><i class="fa fa-fw ' + icon + '"></i>' + label + '</div>' +
            '<div class="bp-kpi-value">' + value + '</div>' +
            (ratio !== undefined ? BP.bar(ratio, { cls: 'bp-kpi-bar' }) : '') +
            '<div class="bp-kpi-sub">' + sub + '</div>' +
            '</div>'
        );
    };
    var count = function (o) {
        return o.running + '<span class="bp-kpi-of">/' + o.total + '</span>';
    };
    var ratio = function (o) {
        return o.max > 0 ? o.used / o.max : 0;
    };

    var cpuR = ratio(m.cpu);
    var memR = ratio(m.mem);
    var diskR = ratio(m.disk);

    var top = function (title, sorter, fmt) {
        var rows = m.guests.slice().sort(sorter).slice(0, 5);
        var body = rows.length
            ? rows
                  .map(function (d) {
                      var f = fmt(d);
                      return (
                          '<div class="bp-top-row" data-bp-select="' + BP.esc(d.id) + '">' +
                          '<i class="fa fa-fw ' + (d.type === 'lxc' ? 'fa-cube' : 'fa-desktop') + '"></i>' +
                          '<span class="bp-top-name">' + BP.esc(d.name || d.vmid) +
                          '<span class="bp-top-id">' + d.vmid + ' · ' + BP.esc(d.node) + '</span></span>' +
                          BP.bar(f.ratio, { cls: 'bp-top-bar' }) +
                          '<span class="bp-top-val">' + f.text + '</span>' +
                          '</div>'
                      );
                  })
                  .join('')
            : '<div class="bp-muted bp-top-empty">' + BP.t('No running guests', '没有运行中的虚拟机') + '</div>';
        return '<div class="bp-top"><div class="bp-top-title">' + title + '</div>' + body + '</div>';
    };

    var memRatio = function (d) {
        return d.maxmem > 0 ? d.mem / d.maxmem : 0;
    };

    return (
        '<div class="bp-dash">' +
        '<div class="bp-kpis">' +
        kpi('fa-server', BP.t('Nodes', '节点'), count({ running: m.nodes.online, total: m.nodes.total }), BP.t('online', '在线')) +
        kpi('fa-desktop', BP.t('Virtual machines', '虚拟机'), count(m.qemu), BP.t('running', '运行中')) +
        kpi('fa-cube', BP.t('Containers', '容器'), count(m.lxc), BP.t('running', '运行中')) +
        kpi('fa-microchip', 'CPU', BP.fmtPct(cpuR), m.cpu.max + ' ' + BP.t('cores', '核'), cpuR) +
        kpi('fa-tasks', BP.t('Memory', '内存'), BP.fmtPct(memR), BP.fmtBytes(m.mem.used) + ' / ' + BP.fmtBytes(m.mem.max), memR) +
        kpi('fa-database', BP.t('Storage', '存储'), BP.fmtPct(diskR), BP.fmtBytes(m.disk.used) + ' / ' + BP.fmtBytes(m.disk.max), diskR) +
        '</div>' +
        '<div class="bp-tops">' +
        top(
            BP.t('Top CPU', 'CPU 占用 Top 5'),
            function (a, b) {
                return (b.cpu || 0) - (a.cpu || 0);
            },
            function (d) {
                return { ratio: d.cpu || 0, text: BP.fmtPct(d.cpu || 0) };
            },
        ) +
        top(
            BP.t('Top memory', '内存占用 Top 5'),
            function (a, b) {
                return memRatio(b) - memRatio(a);
            },
            function (d) {
                return { ratio: memRatio(d), text: BP.fmtBytes(d.mem) };
            },
        ) +
        '</div>' +
        '</div>'
    );
};

BP.feature('dc-dashboard', ['PVE.dc.Summary', 'PVE.data.ResourceStore'], function () {
    Ext.define(null, {
        override: 'PVE.dc.Summary',

        initComponent: function () {
            var me = this;
            me.callParent(arguments);

            BP.safe(function () {
                var dash = me.insert(0, {
                    xtype: 'component',
                    itemId: 'bpDashboard',
                    bpFullWidth: true,
                    columnWidth: 1,
                    html: BP.renderDashboard(BP.dashboardModel(PVE.data.ResourceStore.getRange())),
                    listeners: {
                        click: {
                            element: 'el',
                            fn: function (e) {
                                var row = e.getTarget('[data-bp-select]');
                                if (row) {
                                    BP.select(row.getAttribute('data-bp-select'));
                                }
                            },
                        },
                    },
                });

                me.mon(PVE.data.ResourceStore, 'load', BP.safe(function (store) {
                    if (dash.rendered) {
                        dash.update(BP.renderDashboard(BP.dashboardModel(store.getRange())));
                    }
                }));

                var subs = me.down('#subscriptions');
                var subsPanel = subs && subs.up('panel');
                if (subsPanel && subsPanel !== me) {
                    subsPanel.hide();
                    subsPanel.bpFullWidth = false;
                }

                me.addCls('bp-dc');
                BP.cardify(me);
            })();
        },
    });
});
