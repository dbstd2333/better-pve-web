#!/usr/bin/env bash
# better-pve 安装脚本：复制前端资源、注入模板（可选后端补丁）并安装 apt 钩子。
set -euo pipefail

ROOT="${PVE_ROOT:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

TPL="$ROOT/usr/share/pve-manager/index.html.tpl"
CSS_DIR="$ROOT/usr/share/pve-manager/css"
JS_DIR="$ROOT/usr/share/pve-manager/js"
NODES="$ROOT/usr/share/perl5/PVE/API2/Nodes.pm"
OPT="$ROOT/opt/better-pve"
APT_HOOK="$ROOT/etc/apt/apt.conf.d/99better-pve"

usage() {
    echo "用法: $0 [--with-backend] [--reapply]"
}

WITH_BACKEND=0
REAPPLY=0
for arg in "$@"; do
    case "$arg" in
        --with-backend) WITH_BACKEND=1 ;;
        --reapply) REAPPLY=1 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "[better-pve] 未知参数: $arg" >&2; exit 2 ;;
    esac
done

DRY=0
if [ -n "$ROOT" ] || [ "${BPVE_DRY_RUN:-0}" = "1" ]; then
    DRY=1
fi

QUIET=0
if [ "$REAPPLY" = 1 ]; then
    QUIET=1
fi
say() { [ "$QUIET" = 1 ] || echo "[better-pve] $*"; }
warn() { echo "[better-pve] 警告: $*" >&2; }
die() { echo "[better-pve] 错误: $*" >&2; exit 1; }

if [ "$DRY" = 0 ]; then
    [ "$(id -u)" = "0" ] || die "请以 root 身份运行"
    command -v pveversion >/dev/null 2>&1 || die "未找到 pveversion，这不是 PVE 系统"
    if ! pveversion 2>/dev/null | grep -Eq 'pve-manager/(8|9)\.'; then
        die "仅支持 PVE 8.x/9.x（当前: $(pveversion 2>/dev/null | head -n 1)）"
    fi
fi

DIST="$SCRIPT_DIR/dist"
if [ ! -f "$DIST/better-pve.css" ] || [ ! -f "$DIST/better-pve.js" ]; then
    if [ -f "$SCRIPT_DIR/build.sh" ]; then
        say "生成前端资源..."
        ( cd "$SCRIPT_DIR" && bash ./build.sh ) || die "build.sh 执行失败"
    else
        die "缺少 dist/better-pve.css 或 dist/better-pve.js"
    fi
fi

VERSION="$(tr -d '[:space:]' < "$SCRIPT_DIR/VERSION" 2>/dev/null || true)"
[ -n "$VERSION" ] || die "无法读取 VERSION 文件"

BACKEND="$WITH_BACKEND"
if [ "$REAPPLY" = 1 ] && [ -f "$OPT/config" ] && grep -q '^BACKEND=1$' "$OPT/config"; then
    BACKEND=1
fi

[ -f "$TPL" ] || die "找不到模板: $TPL"

# apt 钩子每次 apt 操作都会触发：已注入且版本一致时什么都不做，避免无谓重启服务
if [ "$REAPPLY" = 1 ] \
    && grep -qF "better-pve.js?v=$VERSION\"" "$TPL" \
    && { [ "$BACKEND" = 0 ] || grep -qF '# better-pve:begin' "$NODES" 2>/dev/null; }; then
    exit 0
fi
grep -q '</head>' "$TPL" || die "模板中找不到 </head>，未做修改: $TPL"
# 无标记说明是新文件（如 PVE 升级覆盖），此时刷新备份基线
if [ ! -f "$TPL.bpve-bak" ] || ! grep -qF '<!-- better-pve:begin -->' "$TPL"; then
    cp -p "$TPL" "$TPL.bpve-bak"
fi

BLOCK="$(cat <<EOF
    <!-- better-pve:begin -->
    <link rel="stylesheet" type="text/css" href="/pwt/themes/theme-proxmox-dark.css?ver=[% wtversion %]" />
    <link rel="stylesheet" type="text/css" href="/pve2/css/better-pve.css?v=$VERSION" />
    <script type="text/javascript" src="/pve2/js/better-pve.js?v=$VERSION"></script>
    <!-- better-pve:end -->
EOF
)"

tmp="$(mktemp "${TPL}.bpve.XXXXXX")" || die "无法创建临时文件"
perl -0777 -pe 's/^[ \t]*<!-- better-pve:begin -->[^\n]*\n.*?^[ \t]*<!-- better-pve:end -->[^\n]*\n?//msg' "$TPL" \
    | BPVE_BLOCK="$BLOCK" perl -0777 -pe 's{^([ \t]*)</head>}{$ENV{BPVE_BLOCK} . "\n" . $1 . "</head>"}me' > "$tmp"
chmod 644 "$tmp"
mv "$tmp" "$TPL"

mkdir -p "$CSS_DIR" "$JS_DIR"
cp "$DIST/better-pve.css" "$CSS_DIR/better-pve.css"
cp "$DIST/better-pve.js" "$JS_DIR/better-pve.js"
chmod 644 "$CSS_DIR/better-pve.css" "$JS_DIR/better-pve.js"

CHANGED_NODES=0
if [ "$BACKEND" = 1 ]; then
    SNIPPET="$SCRIPT_DIR/backend/bpve-status.pl.snippet"
    [ -f "$SNIPPET" ] || die "缺少后端片段: $SNIPPET"
    [ -f "$NODES" ] || die "找不到 Nodes.pm: $NODES"

    if [ "$DRY" = 0 ]; then
        if ! dpkg-query -W -f='${Status}' lm-sensors 2>/dev/null | grep -q 'install ok installed'; then
            apt-get install -y lm-sensors >/dev/null || warn "安装 lm-sensors 失败，已跳过"
        fi
    fi

    grep -Eq '^[[:space:]]*\$res->\{pveversion\}[[:space:]]*=' "$NODES" \
        || die "Nodes.pm 中找不到 pveversion 锚点，未做修改"

    if [ ! -f "$NODES.bpve-bak" ] || ! grep -qF '# better-pve:begin' "$NODES"; then
        cp -p "$NODES" "$NODES.bpve-bak"
    fi

    tmp="$(mktemp "${NODES}.bpve.XXXXXX")" || die "无法创建临时文件"
    perl -0777 -pe 's/^[ \t]*#[ \t]*better-pve:begin[^\n]*\n.*?^[ \t]*#[ \t]*better-pve:end[^\n]*\n?//msg' "$NODES" \
        | BPVE_SNIPPET="$(cat "$SNIPPET")" perl -ne 'if (!$done && /^\s*\$res->\{pveversion\}\s*=/) { print; print $ENV{BPVE_SNIPPET}, "\n"; $done = 1; next } print' > "$tmp"
    chmod 644 "$tmp"
    mv "$tmp" "$NODES"
    CHANGED_NODES=1

    if [ "$DRY" = 0 ]; then
        if ! perl -I/usr/share/perl5 -c "$NODES" >/dev/null 2>&1; then
            cp -p "$NODES.bpve-bak" "$NODES"
            die "Nodes.pm 语法检查失败，已从备份还原"
        fi
    fi
fi

if [ "$SCRIPT_DIR" != "$OPT" ]; then
    mkdir -p "$OPT/dist" "$OPT/backend"
    cp "$SCRIPT_DIR/install.sh" "$OPT/install.sh"
    if [ -f "$SCRIPT_DIR/uninstall.sh" ]; then
        cp "$SCRIPT_DIR/uninstall.sh" "$OPT/uninstall.sh"
        chmod 755 "$OPT/uninstall.sh"
    fi
    cp "$SCRIPT_DIR/VERSION" "$OPT/VERSION"
    cp "$DIST/better-pve.css" "$DIST/better-pve.js" "$OPT/dist/"
    for f in "$SCRIPT_DIR/backend/"*; do
        if [ -f "$f" ]; then
            cp "$f" "$OPT/backend/"
        fi
    done
    chmod 755 "$OPT/install.sh"
fi
printf 'BACKEND=%s\n' "$BACKEND" > "$OPT/config"
chmod 644 "$OPT/config"

mkdir -p "$ROOT/etc/apt/apt.conf.d"
cat > "$APT_HOOK" <<'EOF'
DPkg::Post-Invoke { "if [ -x /opt/better-pve/install.sh ]; then /opt/better-pve/install.sh --reapply >/var/log/better-pve.log 2>&1 || true; fi"; };
EOF
chmod 644 "$APT_HOOK"

if [ "$DRY" = 0 ]; then
    systemctl restart pveproxy || warn "重启 pveproxy 失败"
    if [ "$CHANGED_NODES" = 1 ]; then
        systemctl restart pvedaemon || warn "重启 pvedaemon 失败"
    fi
    say "安装完成（后端补丁: $([ "$BACKEND" = 1 ] && echo 已启用 || echo 未启用)），请在浏览器中按 Ctrl+F5 强制刷新"
else
    say "安装完成（DRY 模式，后端补丁: ${BACKEND}）"
fi
