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

# 从 Nodes.pm 中移除 better-pve 片段。旧版本把片段插在 pveversion 之后，PVE-Tools 等脚本
# 在其后追加的代码会落在 begin 行与 eval 行之间；这部分不属于我们，原样保留在原位置。
strip_nodes_block() {
    perl -0777 -pe 's/^[ \t]*#[ \t]*better-pve:begin[^\n]*\n((?:(?!^[ \t]*#[ \t]*better-pve:end).)*?)^[ \t]*eval \{[ \t]*\n.*?^[ \t]*#[ \t]*better-pve:end[^\n]*\n?/$1/msg; s/^[ \t]*#[ \t]*better-pve:begin[^\n]*\n.*?^[ \t]*#[ \t]*better-pve:end[^\n]*\n?//msg' "$1"
}

# 只移除我们自己的标记段，不用 .bpve-bak 整体覆盖：安装之后其他工具（如 PVE-Tools）
# 对同一文件的修改会被保留。备份仅在标记段无法干净移除时兜底。
restore_file() {
    local file="$1" marker="$2" label="$3"
    [ -f "$file" ] || return 0

    if grep -qF "$marker" "$file"; then
        local tmp
        tmp="$(mktemp "${file}.bpve.XXXXXX")" || die "无法创建临时文件"
        if [ "$marker" = "<!-- better-pve:begin -->" ]; then
            perl -0777 -pe 's/^[ \t]*<!-- better-pve:begin -->[^\n]*\n.*?^[ \t]*<!-- better-pve:end -->[^\n]*\n?//msg' "$file" > "$tmp"
        else
            strip_nodes_block "$file" > "$tmp"
        fi
        if grep -qF "$marker" "$tmp"; then
            rm -f "$tmp"
            if [ -f "$file.bpve-bak" ]; then
                cp -p "$file.bpve-bak" "$file"
                warn "$label 中的标记段不完整，已用安装前备份还原（安装后其他工具对该文件的修改会丢失）"
            else
                warn "$label 中的标记段不完整且没有备份，请手动检查: $file"
                return 0
            fi
        else
            chmod 644 "$tmp"
            mv "$tmp" "$file"
            say "已从 $label 移除注入内容"
            if [ "$DRY" = 0 ] && [ "$file" = "$NODES" ] && [ -f "$file.bpve-bak" ] \
                && ! perl -I/usr/share/perl5 -c "$file" >/dev/null 2>&1; then
                cp -p "$file.bpve-bak" "$file"
                warn "移除后 Nodes.pm 语法检查失败，已用安装前备份还原"
            fi
        fi
    else
        say "$label 中没有注入内容（可能已被 PVE 更新覆盖），跳过"
    fi
    rm -f "$file.bpve-bak"
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
