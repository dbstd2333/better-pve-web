// Node status card: hardware temperatures and live network / disk rates.
// Backend fields (bpve_*) come from the optional Nodes.pm patch; without it
// the temperature row hides and rates fall back to the 1-minute RRD average.

BP.parseSensors = function (raw) {
    var data;
    try {
        data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
        return [];
    }
    if (!data || typeof data !== 'object') {
        return [];
    }
    var inputs = function (feature) {
        var out = [];
        Ext.Object.each(feature || {}, function (k, v) {
            if (/^temp\d+_input$/.test(k) && Ext.isNumeric(v)) {
                out.push(Number(v));
            }
        });
        return out;
    };
    var cpu = [];
    var nvme = [];
    var others = [];
    Ext.Object.each(data, function (chip, features) {
        if (!features || typeof features !== 'object') {
            return;
        }
        if (/^(coretemp|k10temp|zenpower|cpu_thermal)/.test(chip)) {
            var pkg = null;
            var cores = [];
            Ext.Object.each(features, function (name, f) {
                var t = inputs(f);
                if (!t.length) {
                    return;
                }
                if (/^(Package|Tctl|Tdie)/.test(name)) {
                    pkg = Math.max(pkg === null ? -Infinity : pkg, Math.max.apply(null, t));
                } else {
                    cores = cores.concat(t);
                }
            });
            var hottest = cores.length ? Math.max.apply(null, cores) : null;
            var v = pkg !== null ? pkg : hottest;
            if (v !== null) {
                cpu.push({ value: v, max: hottest });
            }
        } else if (/^nvme/.test(chip)) {
            var comp = inputs(features.Composite);
            var all = comp.length ? comp : [].concat.apply([], Ext.Object.getValues(features).map(inputs));
            if (all.length) {
                nvme.push(Math.max.apply(null, all));
            }
        } else {
            var t2 = [].concat.apply([], Ext.Object.getValues(features).map(inputs));
            if (t2.length) {
                others.push({ name: chip.split('-')[0], value: Math.max.apply(null, t2) });
            }
        }
    });

    var list = [];
    cpu.forEach(function (c, i) {
        list.push({
            label: 'CPU' + (cpu.length > 1 ? i : ''),
            value: c.value,
            hint: c.max !== null && c.max !== c.value ? BP.t('hottest core', '最热核心') + ' ' + c.max.toFixed(0) + '°C' : '',
        });
    });
    nvme.forEach(function (t, i) {
        list.push({ label: 'NVMe' + (nvme.length > 1 ? i : ''), value: t });
    });
    others.forEach(function (o) {
        list.push({ label: o.name, value: o.value });
    });
    return list;
};

BP.renderTemps = function (list) {
    return list
        .map(function (t) {
            var lv = t.value >= 80 ? 'crit' : t.value >= 60 ? 'warn' : 'ok';
            var qtip = t.hint ? ' data-qtip="' + BP.esc(t.hint) + '"' : '';
            return (
                '<span class="bp-chip bp-lv-' + lv + '"' + qtip + '>' +
                '<span class="bp-chip-label">' + BP.esc(t.label) + '</span>' +
                t.value.toFixed(0) + '°C</span>'
            );
        })
        .join('');
};

BP.renderRatePair = function (aLabel, a, bLabel, b, suffix) {
    var fmt = function (v) {
        return v === null || v === undefined ? '-' : BP.fmtRate(v);
    };
    return (
        '<span class="bp-rate">' +
        '<span class="bp-rate-dir">' + aLabel + '</span>' + fmt(a) +
        '<span class="bp-rate-sep"></span>' +
        '<span class="bp-rate-dir">' + bLabel + '</span>' + fmt(b) +
        (suffix ? '<span class="bp-rate-note">' + suffix + '</span>' : '') +
        '</span>'
    );
};

BP.feature('node-status', ['PVE.node.StatusView'], function () {
    var rate = BP.rateTracker();
    var rrdCache = {}; // node -> {ts, netin, netout}

    // fallback: last sample of the 1-minute RRD (only network is available)
    var rrdFallback = function (node) {
        var c = rrdCache[node];
        var now = Date.now();
        if (!c || now - c.fetched > 30000) {
            rrdCache[node] = Ext.apply(c || {}, { fetched: now });
            Proxmox.Utils.API2Request({
                url: '/nodes/' + encodeURIComponent(node) + '/rrddata',
                params: { timeframe: 'hour', cf: 'AVERAGE' },
                method: 'GET',
                success: function (resp) {
                    var rows = (resp.result && resp.result.data) || [];
                    for (var i = rows.length - 1; i >= 0; i--) {
                        if (Ext.isNumeric(rows[i].netin)) {
                            Ext.apply(rrdCache[node], { netin: rows[i].netin, netout: rows[i].netout });
                            break;
                        }
                    }
                },
            });
        }
        return rrdCache[node];
    };

    Ext.define(null, {
        override: 'PVE.node.StatusView',

        initComponent: function () {
            var me = this;
            var node = me.pveSelNode && me.pveSelNode.data.node;
            var items = Ext.Array.clone(me.items);

            var tempRow = {
                itemId: 'bpTemps',
                colspan: 2,
                printBar: false,
                iconCls: 'fa fa-fw fa-thermometer-half',
                title: BP.t('Temperatures', '温度'),
                multiField: true,
                hidden: true,
                renderer: BP.safe(function (record) {
                    var raw = record.data.bpve_sensors;
                    var list = raw ? BP.parseSensors(raw) : [];
                    this.setVisible(list.length > 0);
                    return list.length ? BP.renderTemps(list) : '';
                }, ''),
            };

            var netRow = {
                itemId: 'bpNet',
                printBar: false,
                iconCls: 'fa fa-fw fa-exchange',
                title: BP.t('Network', '网络'),
                multiField: true,
                renderer: BP.safe(function (record) {
                    var d = record.data;
                    if (d.bpve_netdev && Ext.isNumeric(d.bpve_ts)) {
                        var r = rate(node + '/net', {
                            rx: BP.sum(d.bpve_netdev, 'rx'),
                            tx: BP.sum(d.bpve_netdev, 'tx'),
                        }, Number(d.bpve_ts));
                        return BP.renderRatePair('↓', r && r.rx, '↑', r && r.tx);
                    }
                    var c = rrdFallback(node);
                    return BP.renderRatePair('↓', c && c.netin, '↑', c && c.netout, BP.t('1 min avg', '1 分钟均值'));
                }, '-'),
            };

            var diskRow = {
                itemId: 'bpDisk',
                printBar: false,
                iconCls: 'fa fa-fw fa-hdd-o',
                title: BP.t('Disk IO', '磁盘 IO'),
                multiField: true,
                renderer: BP.safe(function (record) {
                    var d = record.data;
                    if (d.bpve_diskstats && Ext.isNumeric(d.bpve_ts)) {
                        var r = rate(node + '/disk', {
                            read: BP.sum(d.bpve_diskstats, 'read'),
                            write: BP.sum(d.bpve_diskstats, 'write'),
                        }, Number(d.bpve_ts));
                        return BP.renderRatePair('R', r && r.read, 'W', r && r.write);
                    }
                    return '<span class="bp-muted">' + BP.t('needs backend patch', '需启用后端补丁') + '</span>';
                }, '-'),
            };

            var indexOf = function (id) {
                for (var i = 0; i < items.length; i++) {
                    if (items[i].itemId === id) {
                        return i;
                    }
                }
                return -1;
            };

            var swap = indexOf('swap');
            if (swap >= 0) {
                items.splice(swap + 1, 0, netRow, diskRow);
            } else {
                items.push(netRow, diskRow);
            }
            var cpus = indexOf('cpus');
            items.splice(cpus >= 0 ? cpus + 1 : items.length, 0, tempRow);

            me.items = items;
            me.height = (me.height || 350) + 70;

            me.callParent(arguments);
        },
    });
});
