// Resource tree: inline CPU / memory mini bars next to running nodes and
// guests. The tree only re-renders rows when status-like fields change, so
// bars are also refreshed in place on every ResourceStore load.

BP.feature('tree-metrics', ['PVE.tree.ResourceTree', 'PVE.data.ResourceStore'], function () {
    var KEY = 'tree-metrics';
    var enabled = function () {
        return BP.store.get(KEY, true);
    };
    var applyRootCls = function () {
        document.documentElement.classList.toggle('bp-tree-metrics-off', !enabled());
    };
    applyRootCls();

    var metricsOf = function (d) {
        if (!d || d.template) {
            return null;
        }
        var isGuest = d.type === 'qemu' || d.type === 'lxc';
        if (!(isGuest || d.type === 'node')) {
            return null;
        }
        var running = d.type === 'node' ? d.status === 'online' : d.status === 'running';
        if (!running || !Ext.isNumeric(d.cpu)) {
            return null;
        }
        return {
            cpu: Math.max(0, Math.min(1, Number(d.cpu))),
            mem: d.maxmem > 0 ? Number(d.mem) / Number(d.maxmem) : 0,
            cores: d.maxcpu,
            memText: BP.fmtBytes(d.mem) + ' / ' + BP.fmtBytes(d.maxmem),
        };
    };

    var realId = function (id) {
        // tag view uses ids like "qemu/100-tagname"
        if (id && (id.indexOf('qemu') === 0 || id.indexOf('lxc') === 0)) {
            return id.split('-')[0];
        }
        return id;
    };

    var html = function (id, m) {
        return (
            '<span class="bp-tree-metrics" data-bp-id="' + BP.esc(id) + '">' +
            BP.bar(m.cpu, { cls: 'bp-bar-mini bp-m-cpu', qtip: 'CPU ' + BP.fmtPct(m.cpu) }) +
            BP.bar(m.mem, { cls: 'bp-bar-mini bp-m-mem', qtip: BP.t('Memory', '内存') + ' ' + BP.fmtPct(m.mem) + ' (' + m.memText + ')' }) +
            '</span>'
        );
    };

    var col = PVE.tree.ResourceTree.prototype.columns && PVE.tree.ResourceTree.prototype.columns[0];
    if (!col || typeof col.renderer !== 'function') {
        throw 'tree column renderer not found';
    }
    var origRenderer = col.renderer;
    col.renderer = function (val, meta, rec) {
        var text = origRenderer.apply(this, arguments);
        return BP.safe(function () {
            var id = realId(rec.data.id);
            var live = PVE.data.ResourceStore.getById(id);
            var m = metricsOf(live ? live.data : rec.data);
            return m ? text + html(id, m) : text;
        }, text)();
    };

    var setBar = function (bar, ratio, qtip) {
        if (!bar) {
            return;
        }
        var lv = BP.level(ratio);
        bar.className = bar.className.replace(/bp-lv-\w+/, 'bp-lv-' + lv);
        bar.firstChild.style.width = (ratio * 100).toFixed(1) + '%';
        bar.setAttribute('data-qtip', qtip);
    };

    PVE.data.ResourceStore.on('load', BP.safe(function (store) {
        if (!enabled()) {
            return;
        }
        var els = document.querySelectorAll('.bp-tree-metrics[data-bp-id]');
        for (var i = 0; i < els.length; i++) {
            var rec = store.getById(els[i].getAttribute('data-bp-id'));
            var m = rec && metricsOf(rec.data);
            if (!m) {
                continue; // stopped guests get re-rendered by the tree itself
            }
            setBar(els[i].querySelector('.bp-m-cpu'), m.cpu, 'CPU ' + BP.fmtPct(m.cpu));
            setBar(els[i].querySelector('.bp-m-mem'), m.mem, BP.t('Memory', '内存') + ' ' + BP.fmtPct(m.mem) + ' (' + m.memText + ')');
        }
    }));

    // toggle in the user menu (top right)
    BP.feature('tree-metrics-toggle', ['PVE.StdWorkspace'], function () {
        Ext.define(null, {
            override: 'PVE.StdWorkspace',
            initComponent: function () {
                this.callParent(arguments);
                BP.safe(function () {
                    var btn = Ext.ComponentQuery.query('button[reference=userButton], #userinfo')[0];
                    var menu = btn && btn.getMenu && btn.getMenu();
                    if (!menu) {
                        return;
                    }
                    menu.insert(menu.items.getCount() - 1, {
                        xtype: 'menucheckitem',
                        iconCls: 'fa fa-fw fa-bar-chart',
                        text: BP.t('Tree metrics', '资源树指标'),
                        checked: enabled(),
                        checkHandler: function (_item, checked) {
                            BP.store.set(KEY, checked);
                            applyRootCls();
                        },
                    });
                })();
            },
        });
    });
});
