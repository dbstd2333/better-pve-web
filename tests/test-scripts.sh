#!/usr/bin/env bash
# better-pve 安装/卸载脚本测试：在临时 PVE_ROOT 中验证注入、幂等、卸载与片段语法。
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

R="$TMP/root"
TPL="$R/usr/share/pve-manager/index.html.tpl"
CSS="$R/usr/share/pve-manager/css/better-pve.css"
JS="$R/usr/share/pve-manager/js/better-pve.js"
NODES="$R/usr/share/perl5/PVE/API2/Nodes.pm"
OPT="$R/opt/better-pve"
APT_HOOK="$R/etc/apt/apt.conf.d/99better-pve"
ORIG_TPL="$TMP/orig-index.html.tpl"
ORIG_NODES="$TMP/orig-Nodes.pm"

PASSED=0
fail() {
    echo "FAIL: $*" >&2
    exit 1
}
ok() {
    PASSED=$((PASSED + 1))
    echo "ok $PASSED - $*"
}
assert_eq() {
    [ "$1" = "$2" ] || fail "$3（期望 [$2]，实际 [$1]）"
}
assert_file() {
    [ -f "$1" ] || fail "文件不存在: $1"
}
assert_absent() {
    [ ! -e "$1" ] || fail "本应删除但仍存在: $1"
}
count_marker() {
    grep -c -F "$2" "$1" 2>/dev/null || true
}
file_mode() {
    perl -e 'printf "%o", (stat($ARGV[0]))[2] & 07777' "$1"
}

VERSION="$(tr -d '[:space:]' < VERSION)"
[ -n "$VERSION" ] || fail "VERSION 为空"

# 测试环境准备：src/ 可能尚未产出资源，允许使用空的 dist 占位
mkdir -p dist
[ -f dist/better-pve.css ] || : > dist/better-pve.css
[ -f dist/better-pve.js ] || : > dist/better-pve.js

setup_root() {
    rm -rf "$R"
    mkdir -p "$R/usr/share/pve-manager/css" "$R/usr/share/pve-manager/js" \
        "$R/usr/share/perl5/PVE/API2" "$R/opt" "$R/etc/apt/apt.conf.d"
    cp tests/fixtures/index.html.tpl "$TPL"
    cp tests/fixtures/Nodes.pm "$NODES"
    cp tests/fixtures/index.html.tpl "$ORIG_TPL"
    cp tests/fixtures/Nodes.pm "$ORIG_NODES"
}

check_installed() {
    assert_eq "$(count_marker "$TPL" '<!-- better-pve:begin -->')" "1" "模板 begin 标记数量"
    assert_eq "$(count_marker "$TPL" '<!-- better-pve:end -->')" "1" "模板 end 标记数量"
    grep -q "better-pve.css?v=$VERSION" "$TPL" || fail "模板未写入正确版本号"
    grep -q "better-pve.js?v=$VERSION" "$TPL" || fail "模板未写入 JS 版本号"
    grep -q '/pwt/themes/theme-proxmox-dark.css?ver=\[% wtversion %\]' "$TPL" \
        || fail "模板未保留 wtversion 变量"
    awk '/<!-- better-pve:begin -->/ { b = NR } /<\/head>/ { h = NR } END { exit (b && h && b < h) ? 0 : 1 }' "$TPL" \
        || fail "注入段不在 </head> 之前"

    assert_eq "$(count_marker "$NODES" '# better-pve:begin')" "1" "Nodes.pm begin 标记数量"
    assert_eq "$(count_marker "$NODES" '# better-pve:end')" "1" "Nodes.pm end 标记数量"
    grep -B1 -E '^[[:space:]]*\$res->\{pveversion\}[[:space:]]*=' "$NODES" \
        | grep -qF '# better-pve:end' || fail "片段未紧贴在 pveversion 行之前"

    assert_file "$CSS"
    assert_file "$JS"
    cmp -s dist/better-pve.css "$CSS" || fail "CSS 复制内容不一致"
    cmp -s dist/better-pve.js "$JS" || fail "JS 复制内容不一致"
    assert_eq "$(file_mode "$CSS")" "644" "CSS 权限"
    assert_eq "$(file_mode "$JS")" "644" "JS 权限"

    assert_file "$OPT/install.sh"
    assert_file "$OPT/uninstall.sh"
    assert_file "$OPT/VERSION"
    assert_file "$OPT/dist/better-pve.css"
    assert_file "$OPT/dist/better-pve.js"
    assert_file "$OPT/backend/bpve-status.pl.snippet"
    assert_file "$OPT/config"
    grep -qx 'BACKEND=1' "$OPT/config" || fail "config 中 BACKEND 不等于 1"

    assert_file "$APT_HOOK"
    grep -q 'DPkg::Post-Invoke' "$APT_HOOK" || fail "apt 钩子内容不正确"
    grep -q '/opt/better-pve/install.sh --reapply' "$APT_HOOK" || fail "apt 钩子缺少 reapply 调用"
}

echo "== 1. 首次安装（--with-backend）=="
setup_root
PVE_ROOT="$R" ./install.sh --with-backend >"$TMP/install1.log" 2>&1 \
    || { cat "$TMP/install1.log"; fail "install.sh --with-backend 执行失败"; }
check_installed
cmp -s "$TPL.bpve-bak" "$ORIG_TPL" || fail "模板备份与原文件不一致"
cmp -s "$NODES.bpve-bak" "$ORIG_NODES" || fail "Nodes.pm 备份与原文件不一致"
ok "安装结果与备份正确"

echo "== 2. 重复安装（幂等）=="
PVE_ROOT="$R" ./install.sh --with-backend >"$TMP/install2.log" 2>&1 \
    || { cat "$TMP/install2.log"; fail "重复安装失败"; }
check_installed
cmp -s "$TPL.bpve-bak" "$ORIG_TPL" || fail "重复安装后模板备份被改动"
cmp -s "$NODES.bpve-bak" "$ORIG_NODES" || fail "重复安装后 Nodes.pm 备份被改动"
ok "重复安装保持幂等"

echo "== 3. 从 /opt/better-pve 执行 --reapply =="
PVE_ROOT="$R" "$OPT/install.sh" --reapply >"$TMP/reapply.log" 2>&1 \
    || { cat "$TMP/reapply.log"; fail "reapply 执行失败"; }
check_installed
assert_eq "$(count_marker "$TPL" '<!-- better-pve:begin -->')" "1" "reapply 后模板标记数量"
assert_eq "$(count_marker "$NODES" '# better-pve:begin')" "1" "reapply 后 Nodes.pm 标记数量"
ok "reapply 成功且未重复注入"

echo "== 4. 后端片段语法与执行 =="
{
    echo 'sub t { my $res = {};'
    cat backend/bpve-status.pl.snippet
    echo '; return $res; } print "ok\n";'
} >"$TMP/snippet_test.pl"
perl -c "$TMP/snippet_test.pl" >"$TMP/snippet_check.log" 2>&1 \
    || { cat "$TMP/snippet_check.log"; fail "后端片段 perl -c 失败"; }
out="$(perl "$TMP/snippet_test.pl" 2>"$TMP/snippet_run.err")" \
    || { cat "$TMP/snippet_run.err"; fail "后端片段执行失败"; }
assert_eq "$out" "ok" "后端片段执行输出"
ok "后端片段语法正确且可安全执行"

echo "== 5. 卸载并逐字节比对 =="
PVE_ROOT="$R" ./uninstall.sh >"$TMP/uninstall1.log" 2>&1 \
    || { cat "$TMP/uninstall1.log"; fail "uninstall.sh 执行失败"; }
cmp -s "$TPL" "$ORIG_TPL" || fail "卸载后模板与原始文件不一致"
cmp -s "$NODES" "$ORIG_NODES" || fail "卸载后 Nodes.pm 与原始文件不一致"
assert_absent "$TPL.bpve-bak"
assert_absent "$NODES.bpve-bak"
assert_absent "$CSS"
assert_absent "$JS"
assert_absent "$OPT"
assert_absent "$APT_HOOK"
ok "卸载后完全还原"

echo "== 6. PVE 升级覆盖模板后卸载 =="
setup_root
PVE_ROOT="$R" ./install.sh --with-backend >"$TMP/install3.log" 2>&1 \
    || { cat "$TMP/install3.log"; fail "场景 6 安装失败"; }
cp tests/fixtures/index.html.tpl "$TPL"
PVE_ROOT="$R" ./uninstall.sh >"$TMP/uninstall2.log" 2>&1 \
    || { cat "$TMP/uninstall2.log"; fail "场景 6 卸载失败"; }
cmp -s "$TPL" "$ORIG_TPL" || fail "被升级覆盖的模板被旧备份覆盖了"
assert_absent "$TPL.bpve-bak"
cmp -s "$NODES" "$ORIG_NODES" || fail "场景 6 Nodes.pm 未还原"
ok "升级覆盖场景不破坏新模板"

# 模拟 PVE-Tools 温度补丁的写法：在 version_text 所在行的「下一行」之后插入代码（无结束标记）
apply_pvetools_patch() {
    local ln pt
    pt="$TMP/pvetools-patch.txt"
    printf '\n#modbyshowtempfreq\n\n        $res->{thermalstate} = `sensors -A`;\n        $res->{cpuFreq} = `cat /proc/cpuinfo`;\n' > "$pt"
    ln=$(( $(sed -n -e '/PVE::pvecfg::version_text/=' "$NODES") + 1 ))
    sed "${ln}r $pt" "$NODES" > "$NODES.pt" && mv "$NODES.pt" "$NODES"
}

echo "== 7. 先装 better-pve 再装 PVE-Tools 温度补丁 =="
setup_root
PVE_ROOT="$R" ./install.sh --with-backend >"$TMP/install4.log" 2>&1 \
    || { cat "$TMP/install4.log"; fail "场景 7 安装失败"; }
apply_pvetools_patch
cp "$NODES" "$TMP/expect-pt.pm"
perl -0777 -ne 'exit(/better-pve:begin.*modbyshowtempfreq.*better-pve:end/s ? 1 : 0)' "$NODES" \
    || fail "PVE-Tools 代码落进了 better-pve 标记块"
PVE_ROOT="$R" ./install.sh --with-backend >"$TMP/install5.log" 2>&1 \
    || { cat "$TMP/install5.log"; fail "场景 7 重装失败"; }
cmp -s "$NODES" "$TMP/expect-pt.pm" || fail "重装改动了 PVE-Tools 补丁"
PVE_ROOT="$R" ./install.sh --reapply >"$TMP/reapply2.log" 2>&1 \
    || { cat "$TMP/reapply2.log"; fail "场景 7 reapply 失败"; }
cmp -s "$NODES" "$TMP/expect-pt.pm" || fail "reapply 改动了 PVE-Tools 补丁"
PVE_ROOT="$R" ./uninstall.sh >"$TMP/uninstall3.log" 2>&1 \
    || { cat "$TMP/uninstall3.log"; fail "场景 7 卸载失败"; }
assert_eq "$(count_marker "$NODES" 'better-pve')" "0" "场景 7 卸载后 better-pve 残留"
assert_eq "$(count_marker "$NODES" 'modbyshowtempfreq')" "1" "场景 7 卸载后 PVE-Tools 补丁"
cp "$ORIG_NODES" "$NODES"; apply_pvetools_patch
cp "$NODES" "$TMP/pt-only.pm"
PVE_ROOT="$R" ./install.sh --with-backend >/dev/null 2>&1; PVE_ROOT="$R" ./uninstall.sh >/dev/null 2>&1
cmp -s "$NODES" "$TMP/pt-only.pm" || fail "场景 7 卸载后与「仅 PVE-Tools」状态不一致"
ok "先装 better-pve 后装 PVE-Tools：重装 / reapply / 卸载都保留 PVE-Tools 补丁"

echo "== 8. 先装 PVE-Tools 温度补丁再装 better-pve =="
setup_root
apply_pvetools_patch
cp "$NODES" "$TMP/pt-first.pm"
PVE_ROOT="$R" ./install.sh --with-backend >"$TMP/install6.log" 2>&1 \
    || { cat "$TMP/install6.log"; fail "场景 8 安装失败"; }
grep -q 'PVE-Tools' "$TMP/install6.log" || fail "场景 8 未提示检测到 PVE-Tools"
assert_eq "$(count_marker "$NODES" 'modbyshowtempfreq')" "1" "场景 8 安装后 PVE-Tools 补丁"
PVE_ROOT="$R" ./uninstall.sh >"$TMP/uninstall4.log" 2>&1 \
    || { cat "$TMP/uninstall4.log"; fail "场景 8 卸载失败"; }
cmp -s "$NODES" "$TMP/pt-first.pm" || fail "场景 8 卸载后未回到「仅 PVE-Tools」状态"
ok "先装 PVE-Tools 后装 better-pve：卸载后 PVE-Tools 补丁完好"

echo "== 9. 旧版布局（片段在 pveversion 之后且 PVE-Tools 代码落进标记块）=="
setup_root
{
    perl -ne 'print; if (/^\s*\$res->\{pveversion\}\s*=/) { open(my $f, "<", "backend/bpve-status.pl.snippet") or die; print <$f>; }' "$ORIG_NODES"
} > "$NODES"
apply_pvetools_patch
perl -0777 -ne 'exit(/better-pve:begin.*modbyshowtempfreq.*better-pve:end/s ? 0 : 1)' "$NODES" \
    || fail "场景 9 未构造出旧版问题布局"
PVE_ROOT="$R" ./uninstall.sh >"$TMP/uninstall5.log" 2>&1 \
    || { cat "$TMP/uninstall5.log"; fail "场景 9 卸载失败"; }
assert_eq "$(count_marker "$NODES" 'better-pve')" "0" "场景 9 卸载后 better-pve 残留"
assert_eq "$(count_marker "$NODES" 'modbyshowtempfreq')" "1" "场景 9 PVE-Tools 补丁被误删"
grep -qF '$res->{thermalstate}' "$NODES" || fail "场景 9 PVE-Tools 代码被误删"
ok "旧版布局卸载时救回落进标记块的 PVE-Tools 代码"

echo "== 10. 脚本语法检查 =="
for script in install.sh uninstall.sh tests/test-scripts.sh; do
    bash -n "$script" || fail "bash -n 失败: $script"
done
if command -v shellcheck >/dev/null 2>&1; then
    shellcheck -S error install.sh uninstall.sh tests/test-scripts.sh \
        || fail "shellcheck 报告 error"
    ok "bash -n 与 shellcheck 通过"
else
    ok "bash -n 通过（未安装 shellcheck）"
fi

echo "ALL TESTS PASSED"
