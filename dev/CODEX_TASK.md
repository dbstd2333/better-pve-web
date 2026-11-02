# 任务：本地 PVE Web UI 预览服务器（Node，零依赖）

项目根：/Users/qinxurui/code_project/better-pve-web（PVE Web UI 美化包）。
**只新建/修改**：`dev/server.mjs`、`dev/mock/*.mjs`（可拆多个模块）。不要碰 src/、install.sh、uninstall.sh、backend/、tests/、build.sh。

官方 PVE 前端静态文件已解包在 `dev/assets/`（来自 pve-manager 9.2 等 .deb，结构与 Debian 根目录一致，例如 `dev/assets/usr/share/pve-manager/index.html.tpl`）。
目标：`node dev/server.mjs` 后在 http://localhost:8006 （可用 `PORT` 覆盖，HTTP 即可，不要 HTTPS）打开就是一个**无需登录、数据逼真**的 PVE 9 界面，用来调试 CSS/JS 美化。Node v24，只能用内置模块。

## 1. 静态路径映射（照抄 pveproxy，A = dev/assets）
| URL 前缀 | 目录 |
|---|---|
| /pve2/css/ | A/usr/share/pve-manager/css/ |
| /pve2/js/ | A/usr/share/pve-manager/js/ |
| /pve2/images/ | A/usr/share/pve-manager/images/ |
| /pve2/ext6/ | A/usr/share/javascript/extjs/ |
| /pve2/fa/css/ , /pve2/fa/fonts/ | A/usr/share/fonts-font-awesome/css/ 、 /fonts/ |
| /pve2/font-logos/ | A/usr/share/fonts-font-logos/ |
| /pve2/locale/ | A/usr/share/pve-i18n/ |
| /pwt/css/ , /pwt/images/ , /pwt/themes/ | A/usr/share/javascript/proxmox-widget-toolkit/{css,images,themes}/ |
| /proxmoxlib.js | A/usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js |
| /qrcode.min.js | A/usr/share/javascript/qrcodejs/qrcode.min.js |
注意：查询串（?ver=）要忽略；防目录穿越；正确的 Content-Type（js/css/png/svg/woff/woff2/ttf/eot/gif/ico/json）；符号链接要能跟随（字体目录里可能有 symlink，指向绝对路径 /usr/share/... 的话要改写到 A 下再解析）。静态文件加 `Cache-Control: no-store`。

## 2. 我们自己的产物（每次请求现场生成，便于热更新）
- `/pve2/css/better-pve.css` 和 `/pve2/js/better-pve.js`：在请求时执行项目根的 `./build.sh`（child_process.execFileSync），然后返回 `dist/` 下对应文件。build 失败时返回 500 并打印错误。
- 环境变量 `BPVE_OFF=1` 时不注入（用于对比原版）。

## 3. 首页 `/`
读取 `A/usr/share/pve-manager/index.html.tpl`，实现足够的 Template Toolkit 子集：
- `[% var %]`、`[% var.squote %]`、`[%- ... -%]` 的空白控制
- `[% IF cond %]...[% ELSE %]...[% END %]`（可嵌套；cond 支持 `var`、`var != 'x'`、`var == 'x'`）
变量：nodename=`pve1`，lang=`en`，langfile=0（可通过 `?lang=zh_CN` 打开中文：存在 `A/usr/share/pve-i18n/pve-lang-zh_CN.js` 时 langfile=1）、username=`root@pam`、token=`mock-csrf`、debug=0、version=`9.2.25`、wtversion=proxmoxlib.js 第一行 `// x` 中的 x、theme=`crisp`、consenttext=''、i18n_js_mtime=0、arch=`amd64`。
然后模拟 install.sh：在 `</head>` 前插入
```
    <!-- better-pve:begin -->
    <link rel="stylesheet" type="text/css" href="/pwt/themes/theme-proxmox-dark.css?ver=WT" />
    <link rel="stylesheet" type="text/css" href="/pve2/css/better-pve.css?v=dev" />
    <script type="text/javascript" src="/pve2/js/better-pve.js?v=dev"></script>
    <!-- better-pve:end -->
```
响应头里 Set-Cookie：`PVEAuthCookie=PVE:root@pam:MOCK::sig; Path=/`，使前端认为已登录（Proxmox.Utils 会读这个 cookie 判断登录态；请阅读 proxmoxlib.js 中 `authOK`/`getAuthCookie` 等逻辑确认格式，必要时调整让登录窗不弹出）。

## 4. Mock API：`/api2/json/...` 和 `/api2/extjs/...`
响应 `{"data": ...}`（extjs 格式额外加 `"success": 1`）。POST/PUT/DELETE 一律返回 `{data: null}`（创建类返回 `UPID:pve1:...` 字符串即可）。`/access/ticket` POST 返回 ticket + CSRFPreventionToken + username，供登录窗使用。
未知 GET 路径返回 `{data: []}` 并在控制台打印一次 `[mock] unhandled GET <path>`，方便后续补充。

请阅读 `dev/assets/usr/share/pve-manager/js/pvemanagerlib.js` 和 proxmoxlib.js，确认以下页面实际请求哪些接口、字段名和格式，让这些页面**都能正常渲染、没有错误弹窗**：
- 数据中心：Summary（`/cluster/resources`、`/cluster/status`、`/cluster/ceph/...` 可空）、Options、Storage、Backup、Permissions 下的用户列表
- 节点 pve1、pve2：Summary（`/nodes/{n}/status` 每次请求数值要有小幅随机波动；`/nodes/{n}/rrddata?timeframe=hour|day|week|month|year&cf=AVERAGE` 生成平滑的正弦+噪声曲线，字段 cpu、iowait、loadavg、memused、memtotal、swapused、swaptotal、netin、netout、rootused、roottotal、pressure* 等）、Shell 页可以不管、System/Network（`/nodes/{n}/network`）、Disks（`/nodes/{n}/disks/list`）、Updates（`/nodes/{n}/apt/update` 空）、Repositories（`/nodes/{n}/apt/repositories` 给出合理结构）、Task History、Syslog（几行即可）、Subscription（`status: 'notfound'`，用于测试去弹窗）
- VM（qemu）100、101、102 和 CT（lxc）200、201：Summary（`/nodes/{n}/{qemu|lxc}/{id}/status/current`、rrddata 含 cpu、mem、maxmem、netin、netout、diskread、diskwrite）、Hardware/Resources（`/config`、`/pending`）、Options、Snapshots、Backup、Firewall 可空
- 存储 local、local-lvm：Summary、Content（`/nodes/{n}/storage/{s}/content`、`/status`、rrddata）
- 底部任务日志（`/cluster/tasks`，给 5 条，含 1 条失败）
- `/version`、`/nodes`、`/cluster/options`、`/access/permissions`（给 root 全权限，否则按钮全是灰的——请参照 pvemanagerlib 中 caps 的使用确认格式）、`/cluster/nextid`

数据集（`dev/mock/data.mjs`）：
- 节点 pve1（在线，32 核，128 GiB 内存）、pve2（在线，16 核，64 GiB 内存）
- qemu 100 `web-01` running、101 `db-01` running、102 `win11` stopped、103 `k8s-master` running（在 pve2）、9000 `debian-tpl` template
- lxc 200 `nginx-proxy` running、201 `pihole` running、202 `old-ct` stopped（在 pve2）
- 存储 local（dir）、local-lvm（lvmthin）、nas（nfs，shared）
- 部分 guest 带 tags（如 `prod;web`）
- `/cluster/resources`：运行中的 guest 的 cpu、mem 每次请求有波动；netin、netout、diskread、diskwrite 是**随时间单调递增**的累计字节数（按每秒若干 MB 的速率增长，不同 guest 速率不同），用于前端算实时速率。
- `/nodes/{n}/status` 额外返回 better-pve 后端补丁的字段：
  - `bpve_sensors`：字符串，内容为 `sensors -j` 的 JSON，包含 `coretemp-isa-0000`（Package id 0、Core 0..3，`temp1_input` 等字段格式参照 lm-sensors 的 JSON 输出）、`nvme-pci-0100`（Composite）、`acpitz-acpi-0`；温度每次请求有波动，其中一个核心偶尔超过 80°C。
  - `bpve_netdev`：`{ "enp3s0": {rx, tx}, "enp4s0": {rx, tx} }`，单调递增字节数
  - `bpve_diskstats`：`{ "nvme0n1": {read, write}, "sda": {read, write} }`，单调递增字节数
  - `bpve_ts`：当前 unix 秒（浮点数）
  - 环境变量 `BPVE_NO_BACKEND=1` 时不返回这些字段（模拟未打后端补丁）。

## 完成标准
1. `node dev/server.mjs` 能启动，打印 URL。
2. 写一个自检脚本 `dev/mock/selftest.mjs`：启动服务器（随机端口），请求首页（验证注入段存在且没有残留的 `[%`）、几个静态文件（ext-all.js、proxmoxlib.js、theme-proxmox-dark.css、font-awesome 字体）以及上面列出的主要 API，断言状态码为 200 且 JSON 结构正确，然后输出 `SELFTEST OK`。
3. 如果你能用无头浏览器（例如本机已有的 Chrome，可用 `--headless --dump-dom` 或 `--screenshot`）检查页面能渲染出 `PVE.StdWorkspace`，那么就做；如果做不到，就在总结里说明。
最后输出简短总结：文件清单、如何运行、已知未 mock 的接口。
