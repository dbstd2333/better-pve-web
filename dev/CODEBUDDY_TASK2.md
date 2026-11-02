# 任务：接手本地 PVE mock 预览服务器的收尾工作

项目根：/Users/qinxurui/code_project/better-pve-web。之前 Codex 已实现 `dev/server.mjs`、`dev/mock/{data,api,selftest}.mjs`（任务说明见 dev/CODEX_TASK.md，请先通读）。现在由你接手修 bug、补接口。
**只修改** `dev/server.mjs` 与 `dev/mock/*.mjs`。不要碰 src/、build.sh、install.sh 等。
注意：服务器可能正被别人在 8006 端口运行（用于浏览器预览），你自测请用 `PORT=0` 或 selftest 的随机端口，**不要杀掉 8006 上的进程**。
官方前端源码在 dev/assets/usr/share/pve-manager/js/pvemanagerlib.js 和 dev/assets/usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js，判断接口格式时以它们为准。

## 已知问题（浏览器实测）
1. 控制台报错 `Uncaught TypeError: tags is not iterable at updateTagList (pvemanagerlib.js:4007)`，由 pvemanagerlib.js 3997 行附近的请求 success 回调触发。查清它请求的接口（很可能是 `/cluster/options` 或 `/ui-options` 里的 tag 相关字段），按源码要求返回正确的结构。
2. 底部任务列表（`/cluster/tasks`）所有任务的 End Time 和 Status 一直是加载转圈。对照 pvemanagerlib 中任务 grid 的 renderer，返回正确字段（starttime、endtime、status 为 'OK' 或错误信息、upid、type、id、node、user 等），其中 1 条失败的 status 是错误文本。
3. 全面排查：用 selftest 的方式（或你自己写脚本）模拟一次浏览器加载要请求的接口：读 pvemanagerlib.js，把下列页面会发起的 GET 接口都列出来，确认每个都返回符合前端期望的结构：数据中心（Summary、Notes、Cluster、Options、Storage、Backup、Replication、Permissions/Users/API Tokens/Two Factor/Groups/Pools/Roles/Realms、HA、SDN、Firewall、Metric Server、Notifications、Support）、节点（Summary、Notes、Shell 除外、System/Network/Certificates/DNS/Hosts/Options/Time/Syslog、Updates/Repositories、Firewall、Disks/LVM/LVM-Thin/Directory/ZFS、Ceph 可返回未安装、Replication、Task History、Subscription）、VM 100（Summary、Console 除外、Hardware、Cloud-Init、Options、Task History、Monitor 除外、Backup、Replication、Snapshots、Firewall、Permissions）、CT 200（同理，Resources/Network/DNS）、存储 local（Summary、Backups、ISO Images、CT Templates）、local-lvm（Summary、VM Disks、CT Volumes）。
   重点：返回值结构错误会让前端抛异常，"空数组"不是所有接口都能接受（例如对象型接口需要返回对象）。
4. 在 server 控制台里对 unhandled GET 的打印要保留。

## 完成标准
- `node dev/mock/selftest.mjs` 仍输出 SELFTEST OK，并为第 1、2 点新增断言。
- 输出简短总结：修了什么、新增了哪些接口、仍未覆盖的。
