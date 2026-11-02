#!/usr/bin/env bash
# better-pve 卸载脚本：还原模板与 Nodes.pm，删除静态资源、安装副本和 apt 钩子。
set -euo pipefail

ROOT="${PVE_ROOT:-}"
TPL="$ROOT/usr/share/pve-manager/index.html.tpl"
CSS_DIR="$ROOT/usr/share/pve-manager/css"
JS_DIR="$ROOT/usr/share/pve-manager/js"
NODES="$ROOT/usr/share/perl5/PVE/API2/Nodes.pm"
OPT="$ROOT/opt/better-pve"
APT_HOOK="$ROOT/etc/apt/apt.conf.d/99better-pve"

DRY=0
if [ -n "$ROOT" ] || [ "${BPVE_DRY_RUN:-0}" = "1" ]; then
    DRY=1
fi

say() { echo "[better-pve] $*"; }
warn() { echo "[better-pve] 警告: $*" >&2; }
die() { echo "[better-pve] 错误: $*" >&2; exit 1; }

if [ "$DRY" = 0 ]; then
    [ "$(id -u)" = "0" ] || die "请以 root 身份运行"
fi

restore_file() {
    local file="$1" marker="$2" label="$3"
    [ -f "$file" ] || return 0

    if [ -f "$file.bpve-bak" ]; then
        if grep -qF "$marker" "$file"; then
            cp -p "$file.bpve-bak" "$file"
            say "已还原 $label"
        else
            say "$label 已被 PVE 更新覆盖，丢弃旧备份"
        fi
        rm -f "$file.bpve-bak"
    elif grep -qF "$marker" "$file"; then
        local tmp
        tmp="$(mktemp "${file}.bpve.XXXXXX")" || die "无法创建临时文件"
        if [ "$marker" = "<!-- better-pve:begin -->" ]; then
            perl -0777 -pe 's/^[ \t]*<!-- better-pve:begin -->[^\n]*\n.*?^[ \t]*<!-- better-pve:end -->[^\n]*\n?//msg' "$file" > "$tmp"
        else
            perl -0777 -pe 's/^[ \t]*#[ \t]*better-pve:begin[^\n]*\n.*?^[ \t]*#[ \t]*better-pve:end[^\n]*\n?//msg' "$file" > "$tmp"
        fi
        chmod 644 "$tmp"
        mv "$tmp" "$file"
        say "已从 $label 移除注入内容"
    fi
}

restore_file "$TPL" "<!-- better-pve:begin -->" "模板"
restore_file "$NODES" "# better-pve:begin" "Nodes.pm"

rm -f "$CSS_DIR/better-pve.css" "$JS_DIR/better-pve.js"
rm -rf "$OPT"
rm -f "$APT_HOOK"

if [ "$DRY" = 0 ]; then
    systemctl restart pveproxy || warn "重启 pveproxy 失败"
    systemctl restart pvedaemon || warn "重启 pvedaemon 失败"
    say "卸载完成，请在浏览器中按 Ctrl+F5 强制刷新"
else
    say "卸载完成（DRY 模式）"
fi
