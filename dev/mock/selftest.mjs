import assert from 'node:assert/strict';

import { createMockServer } from '../server.mjs';

const server = createMockServer();
let baseUrl;

function listen(instance) {
    return new Promise((resolve, reject) => {
        instance.once('error', reject);
        instance.listen(0, '127.0.0.1', () => {
            instance.off('error', reject);
            resolve(instance.address());
        });
    });
}

function close(instance) {
    return new Promise((resolve, reject) => {
        instance.close((error) => (error ? reject(error) : resolve()));
    });
}

async function get(pathname) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 200, `${pathname} returned ${response.status}`);
    return response;
}

async function getJson(pathname, { extjs = false } = {}) {
    const response = await get(pathname);
    const json = await response.json();
    assert.equal(typeof json, 'object', `${pathname} did not return JSON`);
    assert.ok(Object.hasOwn(json, 'data'), `${pathname} has no data member`);
    if (extjs) {
        assert.equal(json.success, 1, `${pathname} has no extjs success flag`);
    }
    return json.data;
}

try {
    const address = await listen(server);
    baseUrl = `http://127.0.0.1:${address.port}`;

    const originalBackendFlag = process.env.BPVE_NO_BACKEND;
    const originalOffFlag = process.env.BPVE_OFF;

    const home = await get('/');
    assert.match(home.headers.get('set-cookie') || '', /PVEAuthCookie=PVE:root@pam:MOCK::sig/);
    const html = await home.text();
    assert.match(html, /<!-- better-pve:begin -->/);
    assert.match(html, /\/pve2\/css\/better-pve\.css\?v=dev/);
    assert.match(html, /\/pve2\/js\/better-pve\.js\?v=dev/);
    assert.match(html, /PVE\.StdWorkspace/);
    assert.doesNotMatch(html, /\[%/);

    const zhHtml = await (await get('/?lang=zh_CN')).text();
    assert.match(zhHtml, /pve-lang-zh_CN\.js/);

    const staticFiles = [
        ['/pve2/ext6/ext-all.js', /javascript/],
        ['/proxmoxlib.js', /javascript/],
        ['/pwt/themes/theme-proxmox-dark.css', /text\/css/],
        ['/pve2/fa/fonts/fontawesome-webfont.woff2', /font\/woff2/],
        ['/pve2/font-logos/css/font-logos.css', /text\/css/],
        ['/pve2/css/better-pve.css', /text\/css/],
        ['/pve2/js/better-pve.js', /javascript/],
    ];
    for (const [pathname, contentType] of staticFiles) {
        const response = await get(pathname);
        assert.match(response.headers.get('content-type') || '', contentType);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.ok((await response.arrayBuffer()).byteLength > 0);
    }

    const version = await getJson('/api2/json/version');
    assert.equal(version.version, '9.2.25');

    const nodes = await getJson('/api2/json/nodes');
    assert.equal(nodes.length, 2);
    assert.deepEqual(
        nodes.map((node) => node.node).sort(),
        ['pve1', 'pve2'],
    );

    const resources = await getJson('/api2/json/cluster/resources');
    assert.ok(resources.some((resource) => resource.id === 'node/pve1'));
    assert.ok(resources.some((resource) => resource.id === 'qemu/9000' && resource.template === 1));
    assert.ok(resources.some((resource) => resource.id === 'lxc/200'));
    assert.ok(resources.some((resource) => resource.id === 'storage/pve1/nas'));

    const resourcesAgain = await getJson('/api2/json/cluster/resources');
    const runningA = resources.find((resource) => resource.id === 'qemu/100');
    const runningB = resourcesAgain.find((resource) => resource.id === 'qemu/100');
    assert.ok(runningB.netin >= runningA.netin);
    assert.ok(runningB.netout >= runningA.netout);

    const clusterStatus = await getJson('/api2/json/cluster/status');
    assert.equal(clusterStatus.find((entry) => entry.type === 'cluster').quorate, 1);
    assert.equal(clusterStatus.filter((entry) => entry.type === 'node').length, 2);

    const clusterOptions = await getJson('/api2/json/cluster/options');
    assert.equal(clusterOptions.console, 'xtermjs');
    const extjsOptions = await getJson('/api2/extjs/cluster/options', { extjs: true });
    assert.equal(extjsOptions.mac_prefix, 'BC:24:11');

    const nodeStatus = await getJson('/api2/json/nodes/pve1/status');
    assert.equal(nodeStatus.cpuinfo.cpus, 32);
    assert.equal(nodeStatus.memory.total, 128 * 1024 ** 3);
    assert.equal(typeof nodeStatus.bpve_ts, 'number');
    const sensors = JSON.parse(nodeStatus.bpve_sensors);
    assert.ok(sensors['coretemp-isa-0000']['Core 3'].temp5_input > 0);
    assert.ok(nodeStatus.bpve_netdev.enp3s0.rx > 0);
    assert.ok(nodeStatus.bpve_diskstats.nvme0n1.read > 0);

    const statusBefore = nodeStatus.bpve_netdev.enp3s0.rx;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const statusAfter = (await getJson('/api2/json/nodes/pve1/status')).bpve_netdev.enp3s0.rx;
    assert.ok(statusAfter >= statusBefore);

    process.env.BPVE_NO_BACKEND = '1';
    const plainStatus = await getJson('/api2/json/nodes/pve1/status');
    assert.equal(Object.hasOwn(plainStatus, 'bpve_sensors'), false);
    assert.equal(Object.hasOwn(plainStatus, 'bpve_ts'), false);
    if (originalBackendFlag === undefined) {
        delete process.env.BPVE_NO_BACKEND;
    } else {
        process.env.BPVE_NO_BACKEND = originalBackendFlag;
    }

    for (const timeframe of ['hour', 'day', 'week', 'month', 'year']) {
        const rrd = await getJson(
            `/api2/json/nodes/pve1/rrddata?timeframe=${timeframe}&cf=AVERAGE`,
        );
        assert.ok(rrd.length > 10);
        for (const field of ['time', 'cpu', 'iowait', 'memused', 'netin', 'pressurecpusome']) {
            assert.ok(Object.hasOwn(rrd[0], field), `node RRD missing ${field}`);
        }
    }

    const network = await getJson('/api2/json/nodes/pve1/network');
    assert.ok(network.some((iface) => iface.iface === 'vmbr0' && iface.active === 1));
    const disks = await getJson('/api2/json/nodes/pve1/disks/list');
    assert.ok(disks.some((disk) => disk.devpath === '/dev/nvme0n1'));
    assert.ok(Array.isArray(await getJson('/api2/json/nodes/pve1/apt/update')));

    const repositories = await getJson('/api2/json/nodes/pve1/apt/repositories');
    assert.ok(Array.isArray(repositories['standard-repos']));
    assert.ok(Array.isArray(repositories.files));

    const subscription = await getJson('/api2/json/nodes/pve1/subscription');
    assert.equal(subscription.status, 'notfound');

    const guestStatus = await getJson('/api2/json/nodes/pve1/qemu/100/status/current');
    assert.equal(guestStatus.status, 'running');
    assert.equal(guestStatus.name, 'web-01');
    assert.ok(guestStatus.cpus >= 1);

    const guestRrd = await getJson(
        '/api2/json/nodes/pve1/qemu/100/rrddata?timeframe=hour&cf=AVERAGE',
    );
    for (const field of ['cpu', 'mem', 'maxmem', 'netin', 'netout', 'diskread', 'diskwrite']) {
        assert.ok(Object.hasOwn(guestRrd[0], field), `guest RRD missing ${field}`);
    }

    const guestConfig = await getJson('/api2/json/nodes/pve1/qemu/100/config');
    assert.equal(guestConfig.name, 'web-01');
    const pending = await getJson('/api2/json/nodes/pve1/qemu/100/pending');
    assert.ok(pending.some((item) => item.key === 'scsi0'));
    const snapshots = await getJson('/api2/json/nodes/pve1/qemu/100/snapshot');
    assert.ok(snapshots.some((snapshot) => snapshot.name === 'current'));

    const storageStatus = await getJson('/api2/json/nodes/pve1/storage/local/status');
    assert.ok(storageStatus.total > storageStatus.used);
    const storageContent = await getJson(
        '/api2/json/nodes/pve1/storage/local/content?content=backup',
    );
    assert.ok(storageContent.some((item) => item.vmid === 100));
    const storageRrd = await getJson(
        '/api2/json/nodes/pve1/storage/local/rrddata?timeframe=hour&cf=AVERAGE',
    );
    assert.ok(Object.hasOwn(storageRrd[0], 'used'));

    const tasks = await getJson('/api2/json/cluster/tasks');
    assert.equal(tasks.length, 5);
    assert.ok(tasks.some((task) => String(task.status).includes('command failed')));

    const journal = await getJson('/api2/extjs/nodes/pve1/journal', { extjs: true });
    assert.ok(journal.some((entry) => entry.ty === 'cursor'));

    const users = await getJson('/api2/json/access/users');
    assert.ok(users.some((user) => user.userid === 'root@pam'));
    const permissions = await getJson('/api2/json/access/permissions');
    assert.equal(permissions['/']['Sys.Audit'], 1);
    assert.equal(permissions['/']['VM.Allocate'], 1);

    const nextId = await getJson('/api2/json/cluster/nextid');
    assert.equal(nextId, 9001);

    const loginResponse = await fetch(`${baseUrl}/api2/extjs/access/ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=root%40pam&password=mock',
    });
    assert.equal(loginResponse.status, 200);
    const login = await loginResponse.json();
    assert.equal(login.success, 1);
    assert.equal(login.data.username, 'root@pam');
    assert.match(login.data.ticket, /^PVE:/);
    assert.equal(login.data.cap.dc['Sys.Audit'], 1);

    process.env.BPVE_OFF = '1';
    const offHtml = await (await get('/')).text();
    assert.doesNotMatch(offHtml, /<!-- better-pve:begin -->/);
    if (originalOffFlag === undefined) {
        delete process.env.BPVE_OFF;
    } else {
        process.env.BPVE_OFF = originalOffFlag;
    }

    console.log('SELFTEST OK');
} finally {
    if (server.listening) {
        await close(server);
    }
}
