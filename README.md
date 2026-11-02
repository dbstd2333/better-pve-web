# better-pve-web

Proxmox VE 8.x / 9.x Web 界面美化包：现代暗色主题、卡片式概览、数据中心仪表盘、资源树内联指标、表格用量条、实时网速 / 磁盘 IO、硬件温度，并去掉订阅弹窗。

采用**服务端注入**：装在 PVE 主机上，所有访问者自动生效，不需要装浏览器插件。PVE 升级后会通过 apt 钩子自动重新注入。

## 功能

| 功能 | 说明 | 依赖后端补丁 |
|---|---|---|
| 暗色主题 | 以官方 proxmox-dark 为底层，统一配色、圆角、字体、滚动条，所有颜色都是 `src/css/tokens.css` 里的变量 | 否 |
| 去订阅弹窗 | 运行时替换 `Proxmox.Utils.checked_command`，不修改 PVE 库文件 | 否 |
| 卡片式概览 | 节点、VM/CT、数据中心概览改成卡片网格；auto 模式下按宽度排 1–4 列（My Settings 里手动设置的列数仍然优先） | 否 |
| 数据中心仪表盘 | 节点、VM、CT 数量，集群 CPU/内存/存储占比，CPU 和内存 Top 5（点击跳转）；隐藏 Subscriptions 面板 | 否 |
| 资源树指标 | 运行中的节点、VM、CT 旁边显示 CPU 和内存迷你条，可在右上角用户菜单 →“资源树指标”开关 | 否 |
| 表格用量条 | 搜索、数据中心、资源池表格中的 CPU、内存、磁盘百分比列显示为彩色条 | 否 |
| VM/CT 实时速率 | VM/CT 状态卡片显示网络 ↓↑ 和磁盘读写速率 | 否 |
| 节点实时速率 | 节点状态卡片显示网络和磁盘 IO，每秒刷新 | **是**（不装补丁时网络显示 1 分钟均值，磁盘不显示） |
| 节点温度 | CPU、NVMe 等温度，按 <60 / <80 / ≥80 ℃ 分三档着色 | **是**（还需要 `lm-sensors`） |

## 安装

把整个目录拷到 PVE 主机后，以 root 运行：

```bash
scp -r better-pve-web root@<pve-ip>:/root/
```

```bash
cd /root/better-pve-web && ./install.sh --with-backend
```

- 去掉 `--with-backend` 就只装前端，不修改任何 Perl 代码。
- `--with-backend` 会执行以下操作：
  - 安装 `lm-sensors`
  - 在 `/usr/share/perl5/PVE/API2/Nodes.pm` 的节点 status 接口中插入一段带标记、包在 `eval` 里的代码，用于读取 sensors、`/proc/net/dev`、`/proc/diskstats`
  - 插入后用 `perl -c` 检查，失败会自动还原
- 安装完成后，浏览器需要 **Ctrl+F5** 强制刷新。
- 想要温度更全，可以先运行 `sensors-detect` 识别更多传感器。

### 安装脚本改动了什么

| 路径 | 改动 |
|---|---|
| `/usr/share/pve-manager/index.html.tpl` | 在 `</head>` 前插入 `<!-- better-pve:begin/end -->` 标记段；原文件备份为 `.bpve-bak` |
| `/usr/share/pve-manager/{css,js}/better-pve.*` | 新增的样式和脚本 |
| `/usr/share/perl5/PVE/API2/Nodes.pm` | 仅在使用 `--with-backend` 时，插入 `# better-pve:begin/end` 片段；原文件备份为 `.bpve-bak` |
| `/opt/better-pve/` | 安装副本和配置，供升级后重新应用 |
| `/etc/apt/apt.conf.d/99better-pve` | apt 钩子：每次 apt 操作后检查，如果注入被覆盖就重新应用，没被覆盖则什么都不做 |

### 卸载

```bash
/opt/better-pve/uninstall.sh
```

卸载会还原模板和 Nodes.pm，并删除所有新增文件和 apt 钩子。如果 PVE 已经升级、覆盖了这些文件，卸载不会用旧备份去覆盖新文件。

## 本地开发（macOS / Linux，不需要 PVE）

预览环境只用 `curl`、`ar`、`zstd` 把官方 .deb 里的前端静态文件解出来，不安装也不运行 deb；后端接口由 Node mock 服务模拟。

```bash
./dev/fetch-assets.sh
```

```bash
node dev/server.mjs
```

然后打开 http://localhost:8006 。

- `src/` 下的文件改完后刷新浏览器即可看到效果，服务器每次请求都会重新构建。
- `BPVE_OFF=1 node dev/server.mjs`：不注入，用来对比原版界面。
- `BPVE_NO_BACKEND=1 node dev/server.mjs`：模拟没装后端补丁的情况。

### 目录结构

```
src/ORDER            模块合并顺序
src/css/*.css        tokens → base → components → features
src/js/*.js          core（公共工具）+ 每个功能一个模块
backend/             Nodes.pm 补丁片段
build.sh             生成 dist/better-pve.{css,js}
install.sh / uninstall.sh
tests/test-scripts.sh  在模拟的 PVE 目录结构上测试安装和卸载（bash tests/test-scripts.sh）
dev/                 本地预览：资源下载脚本 + mock 服务
```

每个 JS 功能都通过 `BP.feature()` 注册：依赖的 PVE 类不存在时自动跳过，执行出错也只影响这一个功能。在浏览器控制台运行 `BetterPVE.features` 可以查看各功能的状态。

## 兼容性

- 基于 pve-manager 9.2 / proxmox-widget-toolkit 5.2 源码开发，PVE 8.x 理论上也支持（使用的扩展点在 8.x 中同样存在）。
- 本地 mock 环境已验证，**真机仍需在测试环境上验证**后再用于生产环境。
