import {
    ACCESS_PERMISSIONS,
    DAY,
    GiB,
    GUEST_SPECS,
    MiB,
    MOCK_CAPS,
    NODE_SPECS,
    SNAPSHOTS,
    STORAGE_CONFIGS,
    STORAGE_CONTENT,
    STORAGE_SPECS,
    USERS,
    createTasks,
} from './data.mjs';

const STARTED_MS = Date.now();
const MAX_ID = Math.max(...GUEST_SPECS.map((guest) => guest.vmid));
const unhandledGetPaths = new Set();
const APT_SUITE = 'trixie';
const CLUSTER_NAME = 'pve-lab';

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function wave(nowMs, seed, periodMs = 90000, amplitude = 1) {
    const phase = nowMs / periodMs + seed * 1.61803398875;
    return Math.sin(phase) * amplitude + Math.sin(phase * 0.37 + seed) * amplitude * 0.28;
}

function randomAround(base, spread) {
    return base + (Math.random() - 0.5) * spread;
}

function getNode(node) {
    return NODE_SPECS.find((entry) => entry.node === node);
}

function getGuest(node, type, vmid) {
    return GUEST_SPECS.find(
        (entry) => entry.node === node && entry.type === type && entry.vmid === Number(vmid),
    );
}

function getStorageForNode(node, storage) {
    const exact = STORAGE_SPECS.find((entry) => entry.node === node && entry.storage === storage);
    if (exact) {
        return exact;
    }
    return STORAGE_SPECS.find(
        (entry) =>
            entry.storage === storage &&
            entry.shared &&
            (entry.nodes || '').split(',').includes(node),
    );
}

function cumulativeBytes(rate, seed, nowMs) {
    const elapsedSeconds = Math.max(0, nowMs - STARTED_MS) / 1000;
    return Math.floor(seed * 512 * MiB + elapsedSeconds * rate);
}

function nodeUptime(spec, nowMs) {
    return spec.uptime + Math.floor((nowMs - STARTED_MS) / 1000);
}

function guestResource(spec, nowMs) {
    const running = spec.status === 'running';
    const memory = running
        ? Math.round(spec.maxmem * clamp(spec.memRatio + wave(nowMs, spec.vmid, 120000, 0.018), 0, 1))
        : 0;
    const cpu = running
        ? clamp(spec.cpuBase + wave(nowMs, spec.vmid + 3, 75000, 0.035), 0.005, 0.92)
        : 0;
    return {
        id: `${spec.type}/${spec.vmid}`,
        type: spec.type,
        node: spec.node,
        vmid: spec.vmid,
        name: spec.name,
        status: spec.status,
        qmpstatus: spec.type === 'qemu' ? spec.status : undefined,
        template: spec.template,
        cpu,
        maxcpu: spec.maxcpu,
        mem: memory,
        maxmem: spec.maxmem,
        disk: spec.disk,
        maxdisk: spec.maxdisk,
        netin: cumulativeBytes(spec.netInRate, spec.vmid + 11, nowMs),
        netout: cumulativeBytes(spec.netOutRate, spec.vmid + 17, nowMs),
        diskread: cumulativeBytes(spec.diskReadRate, spec.vmid + 23, nowMs),
        diskwrite: cumulativeBytes(spec.diskWriteRate, spec.vmid + 29, nowMs),
        uptime: running ? spec.uptime + Math.floor((nowMs - STARTED_MS) / 1000) : 0,
        tags: spec.tags,
        hastate: 'unmanaged',
    };
}

function nodeResource(spec, nowMs) {
    const cpu = clamp(spec.cpuBase + wave(nowMs, spec.nodeid, 85000, 0.025), 0.01, 0.9);
    const mem = Math.round(
        spec.maxmem * clamp(spec.memRatio + wave(nowMs, spec.nodeid + 8, 140000, 0.012), 0, 1),
    );
    const disk = Math.round(
        spec.rootUsed + wave(nowMs, spec.nodeid + 22, 600000, 180 * MiB),
    );
    return {
        id: `node/${spec.node}`,
        type: 'node',
        node: spec.node,
        status: 'online',
        cpu,
        maxcpu: spec.maxcpu,
        mem,
        maxmem: spec.maxmem,
        disk,
        maxdisk: spec.rootTotal,
        uptime: nodeUptime(spec, nowMs),
        level: spec.level,
        ssl_fingerprint: `AA:${spec.nodeid}:MOCK:PVE:9.2`,
    };
}

function storageResource(spec) {
    return {
        id: `storage/${spec.node}/${spec.storage}`,
        type: 'storage',
        node: spec.node,
        storage: spec.storage,
        status: 'available',
        disk: spec.used,
        maxdisk: spec.total,
        content: spec.content,
        shared: spec.shared,
        plugintype: spec.type,
    };
}

function buildClusterResources(type, nowMs) {
    let resources = [
        ...NODE_SPECS.map((spec) => nodeResource(spec, nowMs)),
        ...GUEST_SPECS.map((spec) => guestResource(spec, nowMs)),
        ...STORAGE_SPECS.map(storageResource),
    ];
    if (type) {
        const allowed = new Set(type.split(','));
        if (allowed.has('vm')) {
            allowed.add('qemu');
            allowed.add('lxc');
        }
        resources = resources.filter((entry) => allowed.has(entry.type));
    }
    return resources;
}

function buildClusterStatus(nowMs) {
    return [
        {
            type: 'cluster',
            id: 'cluster',
            name: CLUSTER_NAME,
            nodes: NODE_SPECS.length,
            quorate: 1,
            version: 6,
            online: 1,
            nodeid: 0,
        },
        ...NODE_SPECS.map((spec) => {
            const resource = nodeResource(spec, nowMs);
            return {
                type: 'node',
                id: `node/${spec.node}`,
                name: spec.node,
                node: spec.node,
                nodeid: spec.nodeid,
                ip: spec.ip,
                level: spec.level,
                local: spec.local,
                online: 1,
                cpuusage: resource.cpu,
                memoryusage: resource.mem / resource.maxmem,
                uptime: resource.uptime,
            };
        }),
    ];
}

function buildNodeStatus(spec, nowMs) {
    const memoryTotal = spec.maxmem;
    const memoryUsed = Math.round(
        memoryTotal * clamp(spec.memRatio + wave(nowMs, spec.nodeid + 4, 70000, 0.015), 0, 1),
    );
    const rootUsed = Math.round(
        spec.rootUsed + wave(nowMs, spec.nodeid + 9, 180000, 320 * MiB),
    );
    const swapUsed = Math.round(spec.swapTotal * 0.08 + Math.abs(wave(nowMs, spec.nodeid + 5, 150000, 18 * MiB)));
    const status = {
        uptime: nodeUptime(spec, nowMs),
        idle: 0,
        cpu: clamp(
            spec.cpuBase + wave(nowMs, spec.nodeid, 62000, 0.03) + (Math.random() - 0.5) * 0.012,
            0.01,
            0.92,
        ),
        wait: clamp(0.006 + Math.abs(wave(nowMs, spec.nodeid + 31, 48000, 0.006)), 0, 0.05),
        loadavg: [
            Number((spec.maxcpu * 0.09 + wave(nowMs, spec.nodeid + 41, 110000, 0.55)).toFixed(2)),
            Number((spec.maxcpu * 0.08 + wave(nowMs, spec.nodeid + 42, 160000, 0.35)).toFixed(2)),
            Number((spec.maxcpu * 0.07 + wave(nowMs, spec.nodeid + 43, 220000, 0.25)).toFixed(2)),
        ],
        cpuinfo: {
            cores: spec.maxcpu,
            cpus: spec.maxcpu,
            sockets: 1,
            model: 'Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz',
            user_hz: 100,
            mhz: '2000.000',
        },
        memory: {
            used: memoryUsed,
            total: memoryTotal,
            free: memoryTotal - memoryUsed,
            available: memoryTotal - memoryUsed,
        },
        rootfs: {
            used: rootUsed,
            total: spec.rootTotal,
            free: spec.rootTotal - rootUsed,
            avail: spec.rootTotal - rootUsed,
        },
        swap: {
            used: swapUsed,
            total: spec.swapTotal,
            free: spec.swapTotal - swapUsed,
        },
        ksm: { shared: Math.round(1.4 * GiB + Math.abs(wave(nowMs, spec.nodeid + 7, 300000, 120 * MiB))) },
        pveversion: spec.managerVersion,
        kversion: `Linux ${spec.kernel}`,
        'current-kernel': {
            sysname: 'Linux',
            release: spec.kernel,
            version: '#1 SMP PREEMPT_DYNAMIC Proxmox 2026-10-20 (2026-10-20)',
        },
        'boot-info': { mode: 'efi', secureboot: 1 },
        status: 'online',
        tags: 'production;lab',
    };

    if (process.env.BPVE_NO_BACKEND !== '1') {
        Object.assign(status, buildBackendTelemetry(spec, nowMs));
    }
    return status;
}

function buildSensorJson(nowMs, spec) {
    const coreBase = [51, 55, 49, 77];
    const core = Object.fromEntries(
        coreBase.map((base, index) => {
            const spike = index === 3 && Math.random() < 0.18 ? 9 : 0;
            const temp = Number(
                (base + spec.nodeid * 0.8 + wave(nowMs, spec.nodeid * 10 + index, 17000, 2.3) + spike).toFixed(1),
            );
            return [
                `Core ${index}`,
                {
                    [`temp${index + 2}_input`]: temp,
                    [`temp${index + 2}_max`]: 100,
                    [`temp${index + 2}_crit`]: 100,
                    [`temp${index + 2}_crit_alarm`]: temp >= 99 ? 1 : 0,
                },
            ];
        }),
    );
    const packageTemp = Number(
        (58 + spec.nodeid * 1.4 + wave(nowMs, spec.nodeid + 90, 20000, 2.8) + (Math.random() - 0.5) * 1.5).toFixed(1),
    );
    const nvmeTemp = Number(
        (41 + wave(nowMs, spec.nodeid + 95, 31000, 2.1) + (Math.random() - 0.5)).toFixed(1),
    );
    const acpiTemp = Number((27.5 + wave(nowMs, spec.nodeid + 99, 45000, 0.9)).toFixed(1));
    return {
        'coretemp-isa-0000': {
            Adapter: 'ISA adapter',
            'Package id 0': {
                temp1_input: packageTemp,
                temp1_max: 80,
                temp1_crit: 100,
                temp1_crit_alarm: packageTemp >= 100 ? 1 : 0,
            },
            ...core,
        },
        'nvme-pci-0100': {
            Adapter: 'PCI adapter',
            Composite: {
                temp1_input: nvmeTemp,
                temp1_max: 81.85,
                temp1_crit: 84.85,
                temp1_crit_alarm: nvmeTemp >= 84.85 ? 1 : 0,
            },
        },
        'acpitz-acpi-0': {
            Adapter: 'ACPI interface',
            temp1: {
                temp1_input: acpiTemp,
                temp1_crit: 110,
            },
        },
    };
}

function buildBackendTelemetry(spec, nowMs) {
    const elapsedSeconds = Math.max(0, nowMs - STARTED_MS) / 1000;
    const nodeOffset = spec.nodeid * 9;
    return {
        bpve_sensors: JSON.stringify(buildSensorJson(nowMs, spec)),
        bpve_netdev: {
            enp3s0: {
                rx: Math.floor((42 * GiB + elapsedSeconds * 36.4 * MiB) * 10) / 10,
                tx: Math.floor((18 * GiB + elapsedSeconds * 14.7 * MiB) * 10) / 10,
            },
            enp4s0: {
                rx: Math.floor((9 * GiB + elapsedSeconds * 8.2 * MiB) * 10) / 10,
                tx: Math.floor((6 * GiB + elapsedSeconds * 5.6 * MiB) * 10) / 10,
            },
        },
        bpve_diskstats: {
            nvme0n1: {
                read: Math.floor((128 * GiB + elapsedSeconds * (4.8 + nodeOffset / 10) * MiB) * 10) / 10,
                write: Math.floor((64 * GiB + elapsedSeconds * (7.2 + nodeOffset / 8) * MiB) * 10) / 10,
            },
            sda: {
                read: Math.floor((48 * GiB + elapsedSeconds * 1.1 * MiB) * 10) / 10,
                write: Math.floor((35 * GiB + elapsedSeconds * 2.3 * MiB) * 10) / 10,
            },
        },
        bpve_ts: nowMs / 1000,
    };
}

function timeframeShape(timeframe) {
    switch (timeframe) {
        case 'day':
            return { count: 96, step: 15 * 60 };
        case 'week':
            return { count: 168, step: 60 * 60 };
        case 'month':
            return { count: 120, step: 6 * 60 * 60 };
        case 'year':
            return { count: 120, step: 3 * DAY };
        case 'hour':
        default:
            return { count: 60, step: 60 };
    }
}

function rrdTimestamps(searchParams, nowSeconds) {
    const timeframe = searchParams.get('timeframe') || 'hour';
    const { count, step } = timeframeShape(timeframe);
    const end = Math.floor(nowSeconds / step) * step;
    return Array.from({ length: count }, (_, index) => end - (count - 1 - index) * step);
}

function buildNodeRrd(spec, searchParams, nowMs) {
    const times = rrdTimestamps(searchParams, Math.floor(nowMs / 1000));
    return times.map((time, index) => {
        const cpu = clamp(
            spec.cpuBase + wave(time * 1000, spec.nodeid, 360000, 0.055) + Math.sin(index * 0.41) * 0.012,
            0.01,
            0.95,
        );
        const memused = Math.round(
            spec.maxmem * clamp(spec.memRatio + wave(time * 1000, spec.nodeid + 3, 900000, 0.02), 0, 1),
        );
        const arcsize = Math.round(3.2 * GiB + Math.abs(wave(time * 1000, spec.nodeid + 5, 1200000, 0.8 * GiB)));
        return {
            time,
            cpu,
            iowait: clamp(0.004 + Math.abs(wave(time * 1000, spec.nodeid + 7, 480000, 0.008)), 0, 0.08),
            loadavg: Number((spec.maxcpu * 0.09 + wave(time * 1000, spec.nodeid + 9, 500000, 0.7)).toFixed(3)),
            maxcpu: spec.maxcpu,
            memtotal: spec.maxmem,
            memused,
            memavailable: spec.maxmem - memused - arcsize,
            arcsize,
            swaptotal: spec.swapTotal,
            swapused: Math.round(spec.swapTotal * 0.08 + Math.abs(wave(time * 1000, spec.nodeid + 11, 900000, 8 * MiB))),
            rootused: Math.round(spec.rootUsed + wave(time * 1000, spec.nodeid + 13, 1000000, 800 * MiB)),
            roottotal: spec.rootTotal,
            netin: Math.max(0, 22 * MiB + wave(time * 1000, spec.nodeid + 15, 240000, 15 * MiB)),
            netout: Math.max(0, 12 * MiB + wave(time * 1000, spec.nodeid + 17, 270000, 9 * MiB)),
            pressurecpusome: clamp(0.018 + Math.abs(wave(time * 1000, spec.nodeid + 19, 300000, 0.01)), 0, 1),
            pressureiosome: clamp(0.012 + Math.abs(wave(time * 1000, spec.nodeid + 21, 360000, 0.009)), 0, 1),
            pressureiofull: clamp(0.001 + Math.abs(wave(time * 1000, spec.nodeid + 23, 450000, 0.002)), 0, 1),
            pressurememorysome: clamp(0.009 + Math.abs(wave(time * 1000, spec.nodeid + 25, 420000, 0.005)), 0, 1),
            pressurememoryfull: clamp(0.0005 + Math.abs(wave(time * 1000, spec.nodeid + 27, 500000, 0.001)), 0, 1),
        };
    });
}

function buildGuestRrd(spec, searchParams, nowMs) {
    const times = rrdTimestamps(searchParams, Math.floor(nowMs / 1000));
    const running = spec.status === 'running';
    return times.map((time, index) => {
        const cpu = running
            ? clamp(spec.cpuBase + wave(time * 1000, spec.vmid, 300000, 0.07) + Math.sin(index * 0.37) * 0.015, 0.002, 0.98)
            : 0;
        return {
            time,
            cpu,
            maxcpu: spec.maxcpu,
            mem: running
                ? Math.round(spec.maxmem * clamp(spec.memRatio + wave(time * 1000, spec.vmid + 3, 420000, 0.035), 0, 1))
                : 0,
            maxmem: spec.maxmem,
            memhost: running ? Math.round(spec.maxmem * spec.memRatio * 1.06) : 0,
            disk: spec.disk,
            maxdisk: spec.maxdisk,
            netin: running ? Math.max(0, spec.netInRate + wave(time * 1000, spec.vmid + 5, 220000, spec.netInRate * 0.65)) : 0,
            netout: running ? Math.max(0, spec.netOutRate + wave(time * 1000, spec.vmid + 7, 250000, spec.netOutRate * 0.6)) : 0,
            diskread: running ? Math.max(0, spec.diskReadRate + wave(time * 1000, spec.vmid + 9, 190000, spec.diskReadRate * 0.75)) : 0,
            diskwrite: running ? Math.max(0, spec.diskWriteRate + wave(time * 1000, spec.vmid + 11, 210000, spec.diskWriteRate * 0.7)) : 0,
            pressurecpusome: running ? clamp(0.015 + Math.abs(wave(time * 1000, spec.vmid + 13, 260000, 0.01)), 0, 1) : 0,
            pressurecpufull: running ? clamp(0.002 + Math.abs(wave(time * 1000, spec.vmid + 15, 340000, 0.002)), 0, 1) : 0,
            pressureiosome: running ? clamp(0.01 + Math.abs(wave(time * 1000, spec.vmid + 17, 230000, 0.008)), 0, 1) : 0,
            pressureiofull: running ? clamp(0.001 + Math.abs(wave(time * 1000, spec.vmid + 19, 310000, 0.0015)), 0, 1) : 0,
            pressurememorysome: running ? clamp(0.008 + Math.abs(wave(time * 1000, spec.vmid + 21, 320000, 0.005)), 0, 1) : 0,
            pressurememoryfull: running ? clamp(0.0005 + Math.abs(wave(time * 1000, spec.vmid + 23, 400000, 0.001)), 0, 1) : 0,
        };
    });
}

function buildStorageRrd(spec, searchParams, nowMs) {
    const times = rrdTimestamps(searchParams, Math.floor(nowMs / 1000));
    return times.map((time) => ({
        time,
        total: spec.total,
        used: Math.round(spec.used + wave(time * 1000, spec.storage.length + spec.node.length, 900000, 1.6 * GiB)),
    }));
}

function buildNodeNetwork(spec) {
    const bridge = `vmbr0`;
    return [
        {
            iface: 'enp3s0',
            type: 'eth',
            active: 1,
            exists: 1,
            autostart: 1,
            method: 'manual',
            address: '',
            cidr: '',
            comments: 'Primary uplink',
            altnames: ['enx001122334455'],
        },
        {
            iface: 'enp4s0',
            type: 'eth',
            active: 1,
            exists: 1,
            autostart: 1,
            method: 'manual',
            address: '',
            cidr: '',
            comments: 'VM uplink',
        },
        {
            iface: bridge,
            type: 'bridge',
            active: 1,
            exists: 1,
            autostart: 1,
            method: 'static',
            address: spec.ip,
            cidr: `${spec.ip}/24`,
            netmask: '255.255.255.0',
            gateway: '10.0.20.1',
            gateway6: '',
            bridge_ports: 'enp3s0',
            bridge_stp: 'off',
            bridge_fd: '0',
            bridge_vlan_aware: 0,
            comments: 'Management bridge',
            families: ['inet'],
        },
        {
            iface: 'vmbr1',
            type: 'bridge',
            active: 1,
            exists: 1,
            autostart: 1,
            method: 'static',
            address: spec.node === 'pve1' ? '10.0.30.11' : '10.0.30.12',
            cidr: spec.node === 'pve1' ? '10.0.30.11/24' : '10.0.30.12/24',
            netmask: '255.255.255.0',
            gateway: '',
            bridge_ports: 'enp4s0',
            bridge_stp: 'off',
            bridge_fd: '0',
            bridge_vlan_aware: 1,
            comments: 'VLAN-aware VM bridge',
            families: ['inet'],
        },
    ];
}

function buildDisks(spec) {
    const suffix = spec.nodeid;
    return [
        {
            devpath: '/dev/nvme0n1',
            size: 1024 * GiB,
            type: 'ssd',
            health: 'PASSED',
            vendor: 'Samsung',
            model: 'PM9A3 1.92TB',
            serial: `S6B0NL0T${suffix}001`,
            rpm: 0,
            gpt: 1,
            used: 'LVM',
            mounted: 0,
            wearout: 4 + suffix,
            partitions: [
                {
                    devpath: '/dev/nvme0n1p1',
                    size: 1 * GiB,
                    type: 'partition',
                    used: 'bios',
                    mounted: 0,
                },
                {
                    devpath: '/dev/nvme0n1p2',
                    size: 511 * GiB,
                    type: 'partition',
                    used: 'lvm',
                    mounted: 0,
                },
            ],
        },
        {
            devpath: '/dev/sda',
            size: 4 * 1024 * GiB,
            type: 'hdd',
            health: 'PASSED',
            vendor: 'Seagate',
            model: 'IronWolf Pro 4TB',
            serial: `ZA4${suffix}MOCK001`,
            rpm: 7200,
            gpt: 1,
            used: 'ZFS',
            mounted: 0,
            partitions: [],
        },
    ];
}

function buildAptRepositories() {
    return {
        digest: 'mock-apt-repositories-digest',
        errors: [],
        infos: [
            {
                path: '/etc/apt/sources.list.d/pve-no-subscription.sources',
                index: 0,
                kind: 'origin',
                message: 'Proxmox',
            },
            {
                path: '/etc/apt/sources.list',
                index: 0,
                kind: 'origin',
                message: 'Debian',
            },
        ],
        files: [
            {
                path: '/etc/apt/sources.list.d/pve-no-subscription.sources',
                repositories: [
                    {
                        Enabled: 1,
                        Types: 'deb',
                        URIs: 'http://download.proxmox.com/debian/pve',
                        Suites: APT_SUITE,
                        Components: 'pve-no-subscription',
                        Options: '',
                        Comment: 'Proxmox VE no-subscription repository',
                    },
                ],
            },
            {
                path: '/etc/apt/sources.list',
                repositories: [
                    {
                        Enabled: 1,
                        Types: 'deb',
                        URIs: 'http://deb.debian.org/debian',
                        Suites: APT_SUITE,
                        Components: 'main contrib non-free-firmware',
                        Options: '',
                        Comment: 'Debian main repository',
                    },
                ],
            },
        ],
        'standard-repos': [
            { handle: 'enterprise', name: 'Proxmox VE Enterprise', status: '' },
            { handle: 'no-subscription', name: 'Proxmox VE No-Subscription', status: 'enabled' },
            { handle: 'test', name: 'Proxmox VE Test', status: '' },
            { handle: 'ceph-enterprise', name: 'Ceph Enterprise', status: '' },
            { handle: 'ceph-no-subscription', name: 'Ceph No-Subscription', status: '' },
            { handle: 'ceph-test', name: 'Ceph Test', status: '' },
        ],
    };
}

function buildSubscription() {
    return {
        status: 'notfound',
        message: 'No subscription key found',
        productname: 'Proxmox VE',
        key: '',
        serverid: 'MOCKPVE0000000001',
        sockets: 2,
        checktime: Math.floor(Date.now() / 1000),
        nextduedate: '',
        signature: 0,
    };
}

function buildServices() {
    return [
        ['pve-cluster', 'pve-cluster', 'Proxmox Cluster File System', 'running', 'active', 'enabled'],
        ['pvedaemon', 'pvedaemon', 'PVE API Daemon', 'running', 'active', 'enabled'],
        ['pveproxy', 'pveproxy', 'PVE API Proxy Server', 'running', 'active', 'enabled'],
        ['pvestatd', 'pvestatd', 'PVE Status Daemon', 'running', 'active', 'enabled'],
        ['pvescheduler', 'pvescheduler', 'PVE Scheduler', 'running', 'active', 'enabled'],
        ['corosync', 'corosync', 'Corosync Cluster Engine', 'running', 'active', 'enabled'],
        ['postfix', 'postfix', 'Postfix Mail Transport Agent', 'running', 'active', 'enabled'],
        ['chrony', 'chrony', 'NTP client/server', 'running', 'active', 'enabled'],
    ].map(([service, name, desc, state, activeState, unitState]) => ({
        service,
        name,
        desc,
        state,
        'active-state': activeState,
        'unit-state': unitState,
    }));
}

function buildJournal(node, searchParams) {
    const nowMs = Date.now();
    const unit = searchParams.get('unit');
    const entries = [
        { t: nowMs - 62000, id: 'systemd', pid: 1, p: 6, msg: `Started Proxmox VE API Proxy Server on ${node}.` },
        { t: nowMs - 41000, id: 'pveproxy', pid: 2481, p: 6, msg: 'Server started on port 8006.' },
        { t: nowMs - 27000, id: 'pvedaemon', pid: 2418, p: 6, msg: 'pvedaemon started with mock dataset.' },
        { t: nowMs - 9000, id: 'sshd', pid: 3921, p: 6, msg: 'Accepted publickey for root from 10.0.20.8 port 51234.' },
    ];
    const result = [
        { ty: 'identifiers', ids: ['systemd', 'pveproxy', 'pvedaemon', 'sshd', 'corosync'] },
        { ty: 'units', names: buildServices().map((service) => service.service) },
        { ty: 'host', h: node },
        ...(unit ? entries.filter((entry) => entry.id === unit || entry.id === 'systemd') : entries),
        { ty: 'reboot' },
        { t: nowMs - 2 * 3600000, id: 'pve-cluster', pid: 1188, p: 6, msg: 'Cluster filesystem initialized.' },
        { ty: 'cursor', c: 'mock-journal-cursor-end' },
        { ty: 'cursor', c: 'mock-journal-cursor-start' },
    ];
    return result;
}

function buildTasksFor(node, searchParams) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const vmid = searchParams.get('vmid');
    return createTasks(nowSeconds).filter(
        (task) => task.node === node && (!vmid || task.id === String(vmid)),
    );
}

function buildQemuConfig(spec) {
    const memoryMiB = Math.round(spec.maxmem / MiB);
    const diskGiB = Math.round(spec.maxdisk / GiB);
    const config = {
        name: spec.name,
        cores: spec.maxcpu,
        sockets: 1,
        cpu: 'host',
        memory: memoryMiB,
        balloon: Math.round(memoryMiB * 0.25),
        ostype: spec.ostype,
        machine: 'pc-q35-9.2+pve1',
        bios: 'ovmf',
        scsihw: 'virtio-scsi-single',
        boot: 'order=scsi0;net0',
        agent: '1',
        vga: 'qxl',
        serial0: 'socket',
        scsi0: `local-lvm:vm-${spec.vmid}-disk-0,size=${diskGiB}G,ssd=1`,
        net0: `virtio=BC:24:11:${String(spec.vmid).padStart(2, '0')}:A1:01,bridge=vmbr0,firewall=1`,
        tags: spec.tags,
    };
    if (spec.vmid === 100) {
        config.ide2 = 'local:iso/debian-12.9.0-amd64-netinst.iso,media=cdrom';
    }
    if (spec.vmid === 102) {
        config.bios = 'ovmf';
        config.ostype = 'win11';
        config.net0 = 'e1000e=BC:24:11:66:A1:02,bridge=vmbr1';
        config.tpmstate0 = 'local-lvm:vm-102-disk-1,size=4M,version=v2.0';
    }
    return config;
}

function buildLxcConfig(spec) {
    return {
        hostname: spec.name,
        arch: 'amd64',
        ostype: spec.ostype,
        cores: spec.maxcpu,
        memory: Math.round(spec.maxmem / MiB),
        swap: Math.round(spec.maxmem / MiB / 2),
        rootfs: `local-lvm:subvol-${spec.vmid}-disk-0,size=${Math.round(spec.maxdisk / GiB)}G`,
        net0: `name=eth0,bridge=vmbr0,ip=${spec.vmid === 201 ? '10.0.20.53/24' : 'dhcp'},gw=10.0.20.1,firewall=1`,
        nameserver: '1.1.1.1 8.8.8.8',
        searchdomain: 'example.lan',
        unprivileged: 1,
        features: 'nesting=1',
        tags: spec.tags,
    };
}

function pendingFromConfig(config) {
    return Object.entries(config).map(([key, value]) => ({
        key,
        value: typeof value === 'string' ? value : String(value),
    }));
}

function buildGuestStatus(spec, nowMs) {
    const running = spec.status === 'running';
    const mem = running
        ? Math.round(spec.maxmem * clamp(spec.memRatio + wave(nowMs, spec.vmid + 2, 88000, 0.025), 0, 1))
        : 0;
    const common = {
        name: spec.name,
        status: spec.status,
        template: spec.template,
        cpus: spec.maxcpu,
        cpu: running ? clamp(spec.cpuBase + wave(nowMs, spec.vmid + 4, 70000, 0.045), 0, 0.98) : 0,
        mem,
        maxmem: spec.maxmem,
        disk: spec.disk,
        maxdisk: spec.maxdisk,
        uptime: running ? spec.uptime + Math.floor((nowMs - STARTED_MS) / 1000) : 0,
        tags: spec.tags,
        ha: { managed: 0 },
    };
    if (spec.type === 'qemu') {
        return {
            ...common,
            qmpstatus: spec.status,
            memhost: running ? Math.round(mem * 1.04) : 0,
            netin: cumulativeBytes(spec.netInRate, spec.vmid + 11, nowMs),
            netout: cumulativeBytes(spec.netOutRate, spec.vmid + 17, nowMs),
            diskread: cumulativeBytes(spec.diskReadRate, spec.vmid + 23, nowMs),
            diskwrite: cumulativeBytes(spec.diskWriteRate, spec.vmid + 29, nowMs),
            spice: 0,
            serial: 1,
        };
    }
    return {
        ...common,
        type: 'lxc',
        swap: running ? Math.round(64 * MiB + Math.abs(wave(nowMs, spec.vmid + 6, 140000, 18 * MiB))) : 0,
        maxswap: 512 * MiB,
    };
}

function buildFirewallOptions(node, type, vmid) {
    return {
        enable: 0,
        policy_in: 'DROP',
        policy_out: 'ACCEPT',
        log_level_in: 'nolog',
        log_level_out: 'nolog',
        macfilter: 0,
        node,
        type,
        vmid,
    };
}

function handleGet(pathname, searchParams, segments, nowMs) {
    const nowSeconds = Math.floor(nowMs / 1000);

    if (pathname === '/version') {
        return {
            version: '9.2.25',
            release: '9.2',
            repoid: '7a7f2f4c1f2b2a4d',
        };
    }

    if (pathname === '/cluster/resources') {
        return buildClusterResources(searchParams.get('type'), nowMs);
    }
    if (pathname === '/cluster/status') {
        return buildClusterStatus(nowMs);
    }
    if (pathname === '/cluster/options') {
        return {
            keyboard: 'en',
            console: 'xtermjs',
            email_from: 'root@example.lan',
            mac_prefix: 'BC:24:11',
            migration: 'type=secure,network=10.0.20.0/24',
            ha: 'shutdown_policy=migrate,reboot_policy=conditional',
            'next-id': String(MAX_ID + 1),
            notify: 'target=default-matcher',
            'registered-tags': ['prod', 'web', 'db', 'k8s', 'lab', 'template'],
            'user-tag-access': { 'user-allow': 'free' },
            location: '',
        };
    }
    if (pathname === '/cluster/backup') {
        return [
            {
                id: 'backup-6f1d2c46',
                enabled: 1,
                node: 'pve1',
                storage: 'local',
                schedule: '02:00',
                starttime: '02:00',
                dow: 'mon,tue,wed,thu,fri,sat,sun',
                mode: 'snapshot',
                compress: 'zstd',
                all: 1,
                'prune-backups': 'keep-last=7,keep-weekly=4',
                comment: 'Nightly guest backups',
                'next-run': nowSeconds + 3600,
                'repeat-missed': 0,
            },
        ];
    }
    if (pathname === '/cluster/backup-info/not-backed-up') {
        return [];
    }
    if (pathname === '/cluster/nextid') {
        return MAX_ID + 1;
    }
    if (pathname === '/cluster/tasks') {
        const limit = Number(searchParams.get('limit') || 50);
        const vmid = searchParams.get('vmid');
        return createTasks(nowSeconds)
            .filter((task) => !vmid || task.id === String(vmid))
            .slice(0, limit);
    }
    if (pathname === '/cluster/log') {
        return [
            {
                time: nowSeconds - 420,
                node: 'pve1',
                tag: 'pvedaemon',
                pid: 2418,
                user: 'root@pam',
                pri: 5,
                msg: 'starting task UPID:pve1:000F4240:000F4241:000F4242:qmstart:100:root@pam:',
            },
            {
                time: nowSeconds - 3500,
                node: 'pve2',
                tag: 'pveproxy',
                pid: 2141,
                user: 'admin@pve',
                pri: 5,
                msg: 'successful auth for user admin@pve',
            },
        ];
    }
    if (pathname === '/cluster/config/nodes') {
        return NODE_SPECS.map((spec) => ({
            node: spec.node,
            nodeid: spec.nodeid,
            ring0_addr: spec.ip,
            ring1_addr: `10.0.21.${spec.nodeid + 10}`,
            quorum_votes: 1,
        }));
    }
    if (pathname === '/cluster/config') {
        return {
            clustername: CLUSTER_NAME,
            'conf_version': 6,
            'cluster_nodes': NODE_SPECS.length,
        };
    }
    if (
        pathname.startsWith('/cluster/ceph/') ||
        pathname.startsWith('/cluster/ha/') ||
        pathname === '/cluster/replication'
    ) {
        return [];
    }
    if (pathname === '/cluster/firewall/options') {
        return { enable: 0, policy_in: 'DROP', policy_out: 'ACCEPT', ebtables: 0 };
    }
    if (pathname === '/cluster/firewall/refs' || pathname === '/cluster/firewall/macros') {
        return [];
    }

    if (pathname === '/access/users') {
        return USERS;
    }
    if (pathname === '/access/groups') {
        return [{ groupid: 'admins', comment: 'PVE administrators', users: 'root@pam,admin@pve' }];
    }
    if (pathname === '/access/roles') {
        return [
            {
                roleid: 'Administrator',
                privs: Object.keys(ACCESS_PERMISSIONS['/']).join(','),
                special: 1,
            },
            { roleid: 'PVEAuditor', privs: 'Sys.Audit,Datastore.Audit,VM.Audit', special: 1 },
        ];
    }
    if (pathname === '/access/domains') {
        return [
            {
                realm: 'pam',
                type: 'pam',
                comment: 'Linux PAM standard authentication',
                tfa: 'type',
            },
            {
                realm: 'pve',
                type: 'pve',
                comment: 'Proxmox VE authentication server',
                tfa: 'type',
            },
        ];
    }
    if (pathname === '/access/acl') {
        return [
            { path: '/', type: 'user', ugid: 'root@pam', roleid: 'Administrator', propagate: 1 },
            { path: '/', type: 'user', ugid: 'admin@pve', roleid: 'Administrator', propagate: 1 },
            { path: '/', type: 'user', ugid: 'monitor@pve', roleid: 'PVEAuditor', propagate: 1 },
        ];
    }
    if (pathname === '/access/permissions') {
        return ACCESS_PERMISSIONS;
    }
    if (pathname === '/access/tfa') {
        return [];
    }
    if (pathname === '/access/ticket') {
        return buildLoginData();
    }
    if (/^\/access\/users\/[^/]+\/token$/.test(pathname)) {
        return [];
    }

    if (pathname === '/storage') {
        return STORAGE_CONFIGS.map((config) => {
            const totals = STORAGE_SPECS.filter((spec) => spec.storage === config.storage).reduce(
                (sum, spec) => ({ total: sum.total + spec.total, used: sum.used + spec.used }),
                { total: 0, used: 0 },
            );
            return {
                ...config,
                avail: totals.total - totals.used,
                total: totals.total,
                used: totals.used,
            };
        });
    }
    if (pathname === '/pools') {
        return [];
    }
    if (pathname === '/nodes') {
        return NODE_SPECS.map((spec) => ({
            node: spec.node,
            status: 'online',
            cpu: nodeResource(spec, nowMs).cpu,
            maxcpu: spec.maxcpu,
            mem: nodeResource(spec, nowMs).mem,
            maxmem: spec.maxmem,
            uptime: nodeUptime(spec, nowMs),
        }));
    }

    if (segments[0] !== 'nodes' || !segments[1]) {
        return undefined;
    }

    const node = decodeURIComponent(segments[1]);
    const spec = getNode(node);
    if (!spec) {
        return undefined;
    }

    if (segments.length === 2) {
        return {
            node,
            status: 'online',
            cpu: nodeResource(spec, nowMs).cpu,
            maxcpu: spec.maxcpu,
            mem: nodeResource(spec, nowMs).mem,
            maxmem: spec.maxmem,
            uptime: nodeUptime(spec, nowMs),
        };
    }

    if (segments.length === 3 && segments[2] === 'status') {
        return buildNodeStatus(spec, nowMs);
    }
    if (segments.length === 3 && segments[2] === 'rrddata') {
        return buildNodeRrd(spec, searchParams, nowMs);
    }
    if (segments.length === 3 && segments[2] === 'network') {
        return buildNodeNetwork(spec);
    }
    if (segments.length === 3 && segments[2] === 'services') {
        return buildServices();
    }
    if (segments.length === 3 && segments[2] === 'tasks') {
        return buildTasksFor(node, searchParams);
    }
    if (segments.length === 3 && segments[2] === 'journal') {
        return buildJournal(node, searchParams);
    }
    if (segments.length === 3 && segments[2] === 'syslog') {
        return [
            'Nov 02 10:00:01 pveproxy[2481]: server started',
            'Nov 02 10:01:12 pvedaemon[2418]: authentication succeeded for root@pam',
            'Nov 02 10:02:44 pvescheduler[2520]: updated cluster status',
        ];
    }
    if (segments.length === 3 && segments[2] === 'subscription') {
        return buildSubscription();
    }
    if (segments.length === 3 && segments[2] === 'dns') {
        return { search: 'example.lan', dns1: '1.1.1.1', dns2: '8.8.8.8', dns3: '' };
    }
    if (segments.length === 3 && segments[2] === 'config') {
        return {
            description: `${node} mock node`,
            startall_onboot_delay: 0,
        };
    }
    if (segments.length === 3 && segments[2] === 'time') {
        return {
            timezone: 'Asia/Taipei',
            time: nowSeconds,
            localtime: nowSeconds,
            utc: new Date(nowMs).toUTCString(),
        };
    }
    if (segments.length === 4 && segments[2] === 'certificates' && segments[3] === 'info') {
        return [];
    }
    if (segments.length === 4 && segments[2] === 'hardware' && segments[3] === 'pci') {
        return [];
    }
    if (segments.length === 4 && segments[2] === 'ceph' && segments[3] === 'status') {
        return [];
    }
    if (segments.length === 4 && segments[2] === 'disks' && segments[3] === 'list') {
        return buildDisks(spec);
    }
    if (segments.length === 4 && segments[2] === 'disks' && segments[3] === 'lvm') {
        return [
            {
                lv_name: 'data',
                vg_name: 'pve',
                size: 600 * GiB,
                free: 200 * GiB,
                used: 400 * GiB,
                lv_count: 8,
                lv_size: 380 * GiB,
                vg_size: 600 * GiB,
            },
        ];
    }
    if (segments.length === 4 && segments[2] === 'disks' && segments[3] === 'lvmthin') {
        return [
            {
                lv: 'data',
                vg: 'pve',
                lv_size: 500 * GiB,
                lv_used: 238 * GiB,
                metadata_size: 16 * MiB,
                metadata_used: 1.5 * MiB,
            },
        ];
    }
    if (segments.length === 4 && segments[2] === 'disks' && segments[3] === 'directory') {
        return [
            {
                path: '/var/lib/vz',
                device: '/dev/nvme0n1p2',
                type: 'ext4',
                options: 'discard,relatime',
                unitfile: 'var-lib-vz.mount',
                mounted: 1,
            },
        ];
    }
    if (segments.length === 4 && segments[2] === 'disks' && segments[3] === 'zfs') {
        return [
            {
                name: 'rpool',
                size: 1024 * GiB,
                free: 512 * GiB,
                alloc: 512 * GiB,
                frag: 8,
                health: 'ONLINE',
                dedup: 1,
            },
        ];
    }
    if (segments.length === 4 && segments[2] === 'apt' && segments[3] === 'update') {
        return [];
    }
    if (segments.length === 4 && segments[2] === 'apt' && segments[3] === 'repositories') {
        return buildAptRepositories();
    }
    if (segments.length === 4 && segments[2] === 'apt' && segments[3] === 'versions') {
        return [
            { Package: 'pve-manager', OldVersion: '9.2.25', CurrentState: 'Installed', ManagerVersion: '9.2.25' },
            { Package: 'proxmox-kernel-6.14', OldVersion: '6.14.11-1-pve', CurrentState: 'Installed', RunningKernel: '6.14.11-1-pve' },
        ];
    }
    if (segments.length === 3 && segments[2] === 'storage') {
        const content = searchParams.get('content');
        return STORAGE_SPECS.filter((storage) => {
            const accessible = storage.shared
                ? (storage.nodes || '').split(',').includes(node)
                : storage.node === node;
            const contentMatch = !content || storage.content.split(',').includes(content);
            return accessible && contentMatch;
        }).map((storage) => ({
            storage: storage.storage,
            active: storage.active,
            type: storage.type,
            avail: storage.total - storage.used,
            total: storage.total,
            used: storage.used,
            nodes: storage.nodes,
            shared: storage.shared,
            content: storage.content,
            disable: 0,
        }));
    }
    if (segments.length === 5 && segments[2] === 'storage' && segments[4] === 'content') {
        const storage = getStorageForNode(node, decodeURIComponent(segments[3]));
        if (!storage) {
            return [];
        }
        const content = searchParams.get('content');
        return STORAGE_CONTENT.filter((item) => {
            const sameStorage = item.storage === storage.storage;
            const accessible = storage.shared || item.node === node;
            const contentMatch = !content || item.content === content;
            return sameStorage && accessible && contentMatch;
        });
    }
    if (segments.length === 5 && segments[2] === 'storage' && segments[4] === 'status') {
        const storage = getStorageForNode(node, decodeURIComponent(segments[3]));
        return storage
            ? {
                  active: 1,
                  enabled: 1,
                  disabled: 0,
                  content: storage.content,
                  type: storage.type,
                  used: storage.used,
                  avail: storage.total - storage.used,
                  total: storage.total,
                  shared: storage.shared,
              }
            : {};
    }
    if (segments.length === 5 && segments[2] === 'storage' && segments[4] === 'rrddata') {
        const storage = getStorageForNode(node, decodeURIComponent(segments[3]));
        return storage ? buildStorageRrd(storage, searchParams, nowMs) : [];
    }
    if (segments.length === 4 && (segments[2] === 'qemu' || segments[2] === 'lxc')) {
        return GUEST_SPECS.filter(
            (guest) => guest.node === node && guest.type === segments[2],
        ).map((guest) => guestResource(guest, nowMs));
    }

    const type = segments[2];
    if ((type === 'qemu' || type === 'lxc') && segments[3]) {
        const guest = getGuest(node, type, segments[3]);
        if (!guest) {
            return undefined;
        }
        if (segments[4] === 'status' && segments[5] === 'current') {
            return buildGuestStatus(guest, nowMs);
        }
        if (segments[4] === 'rrddata') {
            return buildGuestRrd(guest, searchParams, nowMs);
        }
        if (segments[4] === 'config') {
            return type === 'qemu' ? buildQemuConfig(guest) : buildLxcConfig(guest);
        }
        if (segments[4] === 'pending') {
            const config = type === 'qemu' ? buildQemuConfig(guest) : buildLxcConfig(guest);
            return pendingFromConfig(config);
        }
        if (segments[4] === 'snapshot') {
            return SNAPSHOTS[guest.vmid] || [{ name: 'current', description: 'You are here!' }];
        }
        if (segments[4] === 'feature') {
            return { hasFeature: 1 };
        }
        if (segments[4] === 'firewall' && segments[5] === 'options') {
            return buildFirewallOptions(node, type, guest.vmid);
        }
        if (segments[4] === 'firewall' && segments[5] === 'refs') {
            return [];
        }
        if (segments[4] === 'firewall') {
            return [];
        }
    }

    if (segments.length === 5 && segments[2] === 'services' && segments[4] === 'state') {
        return { state: 'running' };
    }

    return undefined;
}

function buildLoginData() {
    return {
        username: 'root@pam',
        ticket: 'PVE:root@pam:MOCK::sig',
        CSRFPreventionToken: 'mock-csrf',
        clustername: CLUSTER_NAME,
        cap: MOCK_CAPS,
    };
}

function buildMockUpid(pathname) {
    const now = Math.floor(Date.now() / 1000).toString(16).toUpperCase().padStart(8, '0');
    const type = pathname.includes('/qemu/')
        ? 'qmstart'
        : pathname.includes('/lxc/')
          ? 'vzstart'
          : 'mocktask';
    return `UPID:pve1:${now}:${now}:${now}:${type}:100:root@pam:`;
}

// Route a single Proxmox API request and return the unwrapped `data` payload.
export function handleMockApi(method, pathname, searchParams) {
    const normalizedPath = pathname.replace(/\/+$/, '') || '/';
    const segments = normalizedPath.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const nowMs = Date.now();

    if (method === 'POST' && normalizedPath === '/access/ticket') {
        return buildLoginData();
    }
    if (method !== 'GET') {
        return method === 'POST' ? buildMockUpid(normalizedPath) : null;
    }

    const result = handleGet(normalizedPath, searchParams, segments, nowMs);
    if (result !== undefined) {
        return result;
    }

    if (!unhandledGetPaths.has(normalizedPath)) {
        unhandledGetPaths.add(normalizedPath);
        console.log(`[mock] unhandled GET ${normalizedPath}`);
    }
    return [];
}

export { buildLoginData };
