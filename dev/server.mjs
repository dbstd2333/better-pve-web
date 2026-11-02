#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
    createReadStream,
    existsSync,
    lstatSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    statSync,
} from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleMockApi } from './mock/api.mjs';
import { MOCK_CAPS } from './mock/data.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS_ROOT = path.join(PROJECT_ROOT, 'dev/assets');
const TEMPLATE_PATH = path.join(ASSETS_ROOT, 'usr/share/pve-manager/index.html.tpl');
const WT_LIBRARY_PATH = path.join(
    ASSETS_ROOT,
    'usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js',
);
const BUILD_SCRIPT = path.join(PROJECT_ROOT, 'build.sh');
const AUTH_COOKIE = 'PVEAuthCookie=PVE:root@pam:MOCK::sig; Path=/';
const STATIC_ROUTES = [
    ['/pve2/css/', 'usr/share/pve-manager/css/'],
    ['/pve2/js/', 'usr/share/pve-manager/js/'],
    ['/pve2/images/', 'usr/share/pve-manager/images/'],
    ['/pve2/ext6/', 'usr/share/javascript/extjs/'],
    ['/pve2/fa/css/', 'usr/share/fonts-font-awesome/css/'],
    ['/pve2/fa/fonts/', 'usr/share/fonts-font-awesome/fonts/'],
    ['/pve2/font-logos/', 'usr/share/fonts-font-logos/'],
    ['/pve2/locale/', 'usr/share/pve-i18n/'],
    ['/pwt/css/', 'usr/share/javascript/proxmox-widget-toolkit/css/'],
    ['/pwt/images/', 'usr/share/javascript/proxmox-widget-toolkit/images/'],
    ['/pwt/themes/', 'usr/share/javascript/proxmox-widget-toolkit/themes/'],
    ['/proxmoxlib.js', 'usr/share/javascript/proxmox-widget-toolkit/proxmoxlib.js'],
    ['/qrcode.min.js', 'usr/share/javascript/qrcodejs/qrcode.min.js'],
];
const CONTENT_TYPES = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.map', 'application/json; charset=utf-8'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
    ['.gif', 'image/gif'],
    ['.ico', 'image/x-icon'],
    ['.woff', 'font/woff'],
    ['.woff2', 'font/woff2'],
    ['.ttf', 'font/ttf'],
    ['.otf', 'font/otf'],
    ['.eot', 'application/vnd.ms-fontobject'],
    ['.html', 'text/html; charset=utf-8'],
    ['.tpl', 'text/plain; charset=utf-8'],
]);

function isInside(base, candidate) {
    const relative = path.relative(base, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function mapAbsoluteAssetTarget(target) {
    const normalized = path.posix.normalize(target.replaceAll('\\', '/'));
    if (!normalized.startsWith('/usr/share/')) {
        return undefined;
    }
    return path.join(ASSETS_ROOT, normalized.slice(1));
}

function resolveAssetPath(relativePath, depth = 0) {
    if (depth > 20) {
        return undefined;
    }

    const parts = relativePath.split('/').filter(Boolean);
    if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
        return undefined;
    }

    let current = ASSETS_ROOT;
    for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        if (!isInside(ASSETS_ROOT, current)) {
            return undefined;
        }

        let stat;
        try {
            stat = lstatSync(current);
        } catch {
            return undefined;
        }

        if (stat.isSymbolicLink()) {
            const target = readlinkSync(current);
            return resolveSymlinkTarget(current, target, parts.slice(index + 1), depth);
        }
    }

    try {
        const real = realpathSync(current);
        return isInside(ASSETS_ROOT, real) ? real : undefined;
    } catch {
        return undefined;
    }
}

function resolveSymlinkTarget(linkPath, targetText, remainder, depth) {
    const target = targetText.trim();
    const mapped = path.isAbsolute(target)
        ? mapAbsoluteAssetTarget(target)
        : path.resolve(path.dirname(linkPath), target);
    if (!mapped || !isInside(ASSETS_ROOT, mapped)) {
        return undefined;
    }
    const candidate = path.join(mapped, ...remainder);
    if (!isInside(ASSETS_ROOT, candidate)) {
        return undefined;
    }
    return resolveAssetPath(path.relative(ASSETS_ROOT, candidate), depth + 1);
}

function contentTypeFor(filePath) {
    return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

function sendText(response, statusCode, text, contentType = 'text/plain; charset=utf-8') {
    const body = Buffer.from(text);
    response.writeHead(statusCode, {
        'Content-Type': contentType,
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
    });
    response.end(body);
}

function sendJson(response, payload, extjs, method = 'GET') {
    const wrapped = extjs ? { data: payload, success: 1 } : { data: payload };
    const body = Buffer.from(JSON.stringify(wrapped));
    response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
    });
    response.end(method === 'HEAD' ? undefined : body);
}

function sendStatic(response, filePath, method) {
    let stat;
    try {
        stat = statSync(filePath);
    } catch {
        return false;
    }
    if (!stat.isFile()) {
        return false;
    }

    response.writeHead(200, {
        'Content-Type': contentTypeFor(filePath),
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
    });
    if (method === 'HEAD') {
        response.end();
    } else {
        const stream = createReadStream(filePath);
        stream.on('error', () => response.destroy());
        stream.pipe(response);
    }
    return true;
}

function quoteSquote(value) {
    return String(value)
        .replaceAll('\\', '\\\\')
        .replaceAll("'", "\\'")
        .replaceAll('\r', '\\r')
        .replaceAll('\n', '\\n');
}

// Render the small Template Toolkit subset used by PVE's index template.
export function renderTemplate(source, variables) {
    let normalized = source
        .replace(/\s+\[%-/g, '[%')
        .replace(/-%\]\s+/g, '%]')
        .replace(/\[%-/g, '[%')
        .replace(/-%\]/g, '%]');
    const tokenPattern = /\[%\s*([\s\S]*?)\s*%\]/g;
    const frames = [];
    let output = '';
    let cursor = 0;
    let match;

    const frameActive = () => (frames.length === 0 ? true : frames[frames.length - 1].active);

    while ((match = tokenPattern.exec(normalized)) !== null) {
        if (frameActive()) {
            output += normalized.slice(cursor, match.index);
        }
        cursor = tokenPattern.lastIndex;
        const directive = match[1].trim();

        if (directive.startsWith('IF ')) {
            const condition = evaluateCondition(directive.slice(3), variables);
            const parentActive = frameActive();
            frames.push({ parentActive, condition, active: parentActive && condition, elseSeen: false });
            continue;
        }
        if (directive === 'ELSE') {
            const frame = frames[frames.length - 1];
            if (!frame || frame.elseSeen) {
                throw new Error('Unexpected ELSE in template');
            }
            frame.elseSeen = true;
            frame.active = frame.parentActive && !frame.condition;
            continue;
        }
        if (directive === 'END') {
            if (frames.pop() === undefined) {
                throw new Error('Unexpected END in template');
            }
            continue;
        }
        if (frameActive()) {
            output += renderValue(directive, variables);
        }
    }

    if (frames.length !== 0) {
        throw new Error('Unclosed IF in template');
    }
    output += normalized.slice(cursor);
    return output;
}

function evaluateCondition(expression, variables) {
    const comparison = expression.match(/^([A-Za-z_]\w*)\s*(==|!=)\s*(['"])([\s\S]*?)\3$/);
    if (comparison) {
        const [, name, operator, , expected] = comparison;
        const actual = variables[name];
        return operator === '==' ? String(actual) === expected : String(actual) !== expected;
    }
    const variable = expression.match(/^([A-Za-z_]\w*)$/);
    if (!variable) {
        throw new Error(`Unsupported template condition: ${expression}`);
    }
    return Boolean(variables[variable[1]]);
}

function renderValue(expression, variables) {
    const variable = expression.match(/^([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?$/);
    if (!variable) {
        throw new Error(`Unsupported template expression: ${expression}`);
    }
    const [, name, filter] = variable;
    if (!Object.hasOwn(variables, name)) {
        throw new Error(`Unknown template variable: ${name}`);
    }
    if (filter === undefined) {
        return String(variables[name] ?? '');
    }
    if (filter === 'squote') {
        return quoteSquote(variables[name] ?? '');
    }
    throw new Error(`Unsupported template filter: ${filter}`);
}

function readWtVersion() {
    const firstLine = readFileSync(WT_LIBRARY_PATH, { encoding: 'utf8' }).split(/\r?\n/, 1)[0];
    const match = firstLine.match(/^\/\/\s*(\S+)/);
    return match?.[1] || 'unknown';
}

function resolveLanguage(searchParams) {
    const requested = searchParams.get('lang') || 'en';
    if (!/^[A-Za-z0-9_-]+$/.test(requested)) {
        return { lang: 'en', langfile: 0 };
    }
    const localePath = path.join(ASSETS_ROOT, 'usr/share/pve-i18n', `pve-lang-${requested}.js`);
    if (existsSync(localePath)) {
        return { lang: requested, langfile: 1 };
    }
    return { lang: 'en', langfile: 0 };
}

function buildIndexHtml(searchParams) {
    const wtversion = readWtVersion();
    const language = resolveLanguage(searchParams);
    const variables = {
        nodename: 'pve1',
        ...language,
        username: 'root@pam',
        token: 'mock-csrf',
        debug: 0,
        version: '9.2.25',
        wtversion,
        theme: 'crisp',
        consenttext: '',
        i18n_js_mtime: 0,
        arch: 'amd64',
    };
    let html = renderTemplate(readFileSync(TEMPLATE_PATH, { encoding: 'utf8' }), variables);

    if (process.env.BPVE_OFF !== '1') {
        const block = `    <!-- better-pve:begin -->
    <link rel="stylesheet" type="text/css" href="/pwt/themes/theme-proxmox-dark.css?ver=${wtversion}" />
    <link rel="stylesheet" type="text/css" href="/pve2/css/better-pve.css?v=dev" />
    <script type="text/javascript" src="/pve2/js/better-pve.js?v=dev"></script>
    <!-- better-pve:end -->
    <script type="text/javascript">
    Ext.onReady(function () {
        var workspace = Ext.ComponentQuery.query('pveStdWorkspace')[0];
        if (!workspace || workspace.loginData) {
            return;
        }
        workspace.updateLoginData({
            username: 'root@pam',
            ticket: 'PVE:root@pam:MOCK::sig',
            CSRFPreventionToken: 'mock-csrf',
            clustername: 'pve-lab',
            cap: ${JSON.stringify(MOCK_CAPS)}
        });
    });
    </script>
`;
        html = html.replace(/^[ \t]*<\/head>/m, `${block}$&`);
    }
    return html;
}

function buildOwnAsset(assetName) {
    try {
        execFileSync(BUILD_SCRIPT, [], {
            cwd: PROJECT_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return readFileSync(path.join(PROJECT_ROOT, 'dist', assetName));
    } catch (error) {
        console.error('[better-pve] build.sh failed');
        if (error.stdout) {
            console.error(String(error.stdout).trim());
        }
        if (error.stderr) {
            console.error(String(error.stderr).trim());
        }
        console.error(error.message);
        return undefined;
    }
}

function serveOwnAsset(response, assetName, method) {
    const body = buildOwnAsset(assetName);
    if (body === undefined) {
        sendText(response, 500, 'better-pve build failed\n');
        return;
    }
    response.writeHead(200, {
        'Content-Type': contentTypeFor(assetName),
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
    });
    response.end(method === 'HEAD' ? undefined : body);
}

function matchStaticRoute(pathname) {
    for (const [prefix, assetRelative] of STATIC_ROUTES) {
        if (pathname === prefix) {
            return { mappedPath: assetRelative, exact: true };
        }
        if (prefix.endsWith('/') && pathname.startsWith(prefix)) {
            return { mappedPath: `${assetRelative}${pathname.slice(prefix.length)}`, exact: false };
        }
    }
    return undefined;
}

function handleApi(response, method, pathname, searchParams) {
    const prefixes = [
        { prefix: '/api2/json', extjs: false },
        { prefix: '/api2/extjs', extjs: true },
    ];
    const matched = prefixes.find(
        ({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
    if (!matched) {
        return false;
    }
    const apiPath = pathname.slice(matched.prefix.length) || '/';
    const data = handleMockApi(method, apiPath, searchParams);
    sendJson(response, data, matched.extjs, method);
    return true;
}

// Create the standalone HTTP server; tests call this directly with an ephemeral port.
export function createMockServer() {
    return createServer((request, response) => {
        const method = request.method || 'GET';
        let parsedUrl;
        try {
            parsedUrl = new URL(request.url || '/', 'http://localhost');
        } catch {
            sendText(response, 400, 'Bad Request\n');
            return;
        }

        let pathname;
        try {
            pathname = decodeURIComponent(parsedUrl.pathname);
        } catch {
            sendText(response, 400, 'Bad Request\n');
            return;
        }

        if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) {
            sendText(response, 400, 'Bad Request\n');
            return;
        }

        if (pathname === '/') {
            if (method !== 'GET' && method !== 'HEAD') {
                sendText(response, 405, 'Method Not Allowed\n');
                return;
            }
            try {
                const html = buildIndexHtml(parsedUrl.searchParams);
                const body = Buffer.from(html);
                response.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Content-Length': body.length,
                    'Cache-Control': 'no-store',
                    'Set-Cookie': AUTH_COOKIE,
                });
                response.end(method === 'HEAD' ? undefined : body);
            } catch (error) {
                console.error('[better-pve] failed to render index template');
                console.error(error);
                sendText(response, 500, 'Failed to render index template\n');
            }
            return;
        }

        if (pathname.startsWith('/api2/')) {
            if (handleApi(response, method, pathname, parsedUrl.searchParams)) {
                return;
            }
        }

        if (pathname === '/pve2/css/better-pve.css') {
            if (method !== 'GET' && method !== 'HEAD') {
                sendText(response, 405, 'Method Not Allowed\n');
                return;
            }
            serveOwnAsset(response, 'better-pve.css', method);
            return;
        }
        if (pathname === '/pve2/js/better-pve.js') {
            if (method !== 'GET' && method !== 'HEAD') {
                sendText(response, 405, 'Method Not Allowed\n');
                return;
            }
            serveOwnAsset(response, 'better-pve.js', method);
            return;
        }

        if (method === 'GET' || method === 'HEAD') {
            const route = matchStaticRoute(pathname);
            if (route?.exact) {
                const filePath = resolveAssetPath(route.mappedPath);
                if (filePath && sendStatic(response, filePath, method)) {
                    return;
                }
            }
            if (route && !route.exact) {
                const filePath = resolveAssetPath(route.mappedPath);
                if (filePath && sendStatic(response, filePath, method)) {
                    return;
                }
            }
        }

        sendText(response, 404, 'Not Found\n');
    });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const requestedPort = process.env.PORT === undefined ? 8006 : Number(process.env.PORT);
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
        console.error(`[better-pve] invalid PORT: ${process.env.PORT}`);
        process.exit(1);
    }
    const server = createMockServer();
    server.listen(requestedPort, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : requestedPort;
        console.log(`[better-pve] mock PVE UI: http://localhost:${port}`);
        if (process.env.BPVE_NO_BACKEND === '1') {
            console.log('[better-pve] backend patch fields disabled (BPVE_NO_BACKEND=1)');
        }
        if (process.env.BPVE_OFF === '1') {
            console.log('[better-pve] better-pve injection disabled (BPVE_OFF=1)');
        }
    });
}
