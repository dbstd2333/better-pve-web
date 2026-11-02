# 任务：better-pve 的安装/卸载脚本 + 后端补丁片段 + 脚本测试

项目根目录：/Users/qinxurui/code_project/better-pve-web（PVE 8.x/9.x Web UI 美化包，服务端注入）。
**只能新建/修改下列文件**，不要碰 src/、dev/（本文件除外）、build.sh、VERSION：
- install.sh
- uninstall.sh
- backend/bpve-status.pl.snippet
- tests/test-scripts.sh

本机是 macOS（bash 3.2 + zsh），脚本最终运行在 Debian 12/13 (PVE) 的 bash 5 上，以 root 执行。
写法要求：`#!/usr/bin/env bash`，`set -euo pipefail`，同时兼容 bash 3.2（测试在 mac 上跑）——不要用关联数组、`${var,,}`、`mapfile`。
sed 不要用 `-i`（GNU/BSD 不兼容），用“写临时文件再 mv”的方式。可用 perl 做文本处理（两端都有）。

## 路径约定
所有绝对路径都加前缀 `$ROOT`，`ROOT="${PVE_ROOT:-}"`（测试时指向临时目录）。
`DRY=1` 当 `PVE_ROOT` 非空或 `BPVE_DRY_RUN=1`：此时跳过 root 检查、pveversion 检查、apt-get、systemctl。

| 用途 | 路径 |
|---|---|
| 模板 | `$ROOT/usr/share/pve-manager/index.html.tpl` |
| 静态 CSS | `$ROOT/usr/share/pve-manager/css/better-pve.css` |
| 静态 JS | `$ROOT/usr/share/pve-manager/js/better-pve.js` |
| 后端 | `$ROOT/usr/share/perl5/PVE/API2/Nodes.pm` |
| 安装副本 | `$ROOT/opt/better-pve/`（存 dist/、backend/、install.sh、uninstall.sh、VERSION、config） |
| apt 钩子 | `$ROOT/etc/apt/apt.conf.d/99better-pve` |

## install.sh
用法：`install.sh [--with-backend] [--reapply]`
1. 非 DRY：必须 root；`pveversion` 输出需匹配 `pve-manager/(8|9)\.`，否则报错退出。
2. 资源来源：脚本所在目录。若 `dist/better-pve.css` 或 `dist/better-pve.js` 不存在且有 `build.sh`，先执行 `./build.sh`。版本号读 `VERSION`。
3. 复制 dist 两个文件到静态目录（mode 644）。
4. 模板注入：
   - 首次（备份不存在时）备份为 `index.html.tpl.bpve-bak`。
   - 删除已有 `<!-- better-pve:begin -->` 到 `<!-- better-pve:end -->` 之间（含标记行）的内容，再在 `</head>` 之前插入下面这段（VERSION 替换成版本号，`[% wtversion %]` 原样保留，它是 PVE 模板变量）：
```
    <!-- better-pve:begin -->
    <link rel="stylesheet" type="text/css" href="/pwt/themes/theme-proxmox-dark.css?ver=[% wtversion %]" />
    <link rel="stylesheet" type="text/css" href="/pve2/css/better-pve.css?v=VERSION" />
    <script type="text/javascript" src="/pve2/js/better-pve.js?v=VERSION"></script>
    <!-- better-pve:end -->
```
   - 找不到 `</head>` 则报错退出，不改文件。
5. `--with-backend`（或 `--reapply` 且 config 里 `BACKEND=1`）：
   - 非 DRY：`apt-get install -y lm-sensors`（已装则跳过；失败只警告，继续）。
   - 首次备份 `Nodes.pm` 为 `Nodes.pm.bpve-bak`。
   - 删除已有 `# better-pve:begin` 到 `# better-pve:end` 的行，再把 backend/bpve-status.pl.snippet 的内容插入到**第一处**匹配 `^\s*\$res->\{pveversion\}\s*=` 的那一行**之后**。找不到锚点则报错、不改文件。
   - 非 DRY：执行 `perl -c` 检查 Nodes.pm（`perl -I/usr/share/perl5 -c ...`）；失败则用备份还原、报错退出。DRY 模式跳过这一步。
6. 把自身（install.sh、uninstall.sh、VERSION、dist/、backend/）复制到 `/opt/better-pve/`，写入 `config`（`BACKEND=0|1`）。如果当前就是从 /opt/better-pve 运行（--reapply），不要自己拷贝自己。
7. 写 apt 钩子：
```
DPkg::Post-Invoke { "if [ -x /opt/better-pve/install.sh ]; then /opt/better-pve/install.sh --reapply >/var/log/better-pve.log 2>&1 || true; fi"; };
```
8. 非 DRY：`systemctl restart pveproxy`；改过 Nodes.pm 时还要 `systemctl restart pvedaemon`。最后打印提示：浏览器 Ctrl+F5 强制刷新。
9. `--reapply`：静默（少打印），逻辑同上；模板若已含 begin 标记且版本一致也照样重写（保证幂等即可）。
输出用简洁中文提示，带 `[better-pve]` 前缀。

## uninstall.sh
1. 模板：有 `.bpve-bak` 则还原并删除备份；否则按标记删除注入段。
2. Nodes.pm：同理（有备份还原，否则按 `# better-pve:begin/end` 删除）。
3. 删除两个静态文件、`/opt/better-pve/`、apt 钩子。
4. 非 DRY：重启 pveproxy、pvedaemon。
注意：备份还原前，若当前文件里**没有**我们的标记（说明 PVE 升级已覆盖），则不要用旧备份覆盖新文件，改为直接删除备份。这一点对模板和 Nodes.pm 都适用。

## backend/bpve-status.pl.snippet
会被插入到 PVE `PVE/API2/Nodes.pm` 中节点 status 接口的 `$res->{pveversion} = ...;` 这一行之后（处于一个 sub 体内，`$res` 是 hashref）。参考上下文见 tests/fixtures/Nodes.pm 第 550 行附近。内容：
```perl
        # better-pve:begin
        eval {
            ...
        };
        # better-pve:end
```
eval 内（全部用 core Perl，不要 use 新模块；出错不得影响原接口）：
- `bpve_sensors`：`my $out = `timeout 2 sensors -j 2>/dev/null`;` 成功且非空则 `$res->{bpve_sensors} = $out`（原样字符串），否则 `''`。
- `bpve_netdev`：读 `/proc/net/dev`，只保留 `/sys/class/net/<if>/device` 存在的接口（物理网卡），结果 `{ <if> => { rx => <bytes>, tx => <bytes> } }`，数字转成数值（`+0`）。
- `bpve_diskstats`：读 `/proc/diskstats`，只保留 `/sys/block/<dev>/device` 存在的设备（排除分区、loop、dm、zd），结果 `{ <dev> => { read => sectors_read*512, write => sectors_written*512 } }`（diskstats 第 6、10 列，1-based 字段编号以内核文档为准：major minor name reads merged sectors_read ms writes merged sectors_written ...）。
- `$res->{bpve_ts} = time();`（可用 Time::HiRes 若已在 Nodes.pm 中 use，否则用内建 time）。

## tests/test-scripts.sh
在 mktemp 目录里构造假的 PVE_ROOT：拷贝 tests/fixtures/index.html.tpl 和 tests/fixtures/Nodes.pm 到对应路径，并创建 `css/`、`js/` 目录。然后断言：
1. `PVE_ROOT=... ./install.sh --with-backend` 成功；模板里恰好一个 begin 标记、版本号正确、位于 `</head>` 之前；Nodes.pm 里恰好一个 `# better-pve:begin`，且紧跟在 pveversion 那行之后；静态文件、/opt 副本、apt 钩子、config(BACKEND=1) 都存在。
2. 再跑一次 install（幂等）：标记数量仍为 1，备份文件内容仍等于原始 fixture。
3. 用 `/opt/better-pve/install.sh --reapply`（PVE_ROOT 同样设置）也成功。
4. 片段语法：把 snippet 包进 `sub t { my $res = {}; <snippet> ; return $res; } print "ok\n";` 用 `perl -c` 检查；并实际执行一次（mac 上没有 /proc，结果为空也不应报错）。
5. `uninstall.sh` 后，模板和 Nodes.pm 与原始 fixture 逐字节相同（`cmp`），静态文件、/opt、钩子都已删除。
6. 场景：install 后模拟“PVE 升级覆盖了模板”（把原 fixture 再拷回去），再 uninstall：模板保持为 fixture、备份被删除、不报错。
7. `bash -n` 检查三个脚本；如果 `shellcheck` 存在就跑一遍（警告可以接受，错误不行）。
全部通过输出 `ALL TESTS PASSED`，任何失败非零退出。

## 完成标准
运行 `bash tests/test-scripts.sh` 输出 ALL TESTS PASSED。注意：dist/ 由 `./build.sh` 生成，src/ 目前可能为空或正在被别人修改——测试里允许 dist 文件为空内容，只检查是否存在和复制是否正确。
完成后在终端输出一段简短总结：改了哪些文件、测试结果、遗留问题。
