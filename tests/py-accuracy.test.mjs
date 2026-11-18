// Python 准确率改进的回归测试（2026-11-18，tests/benchmark/python 基准驱动）。
// 完整打分用 `node scripts/bench-py.mjs`（要跑依赖审计，慢）；这里只锁住提取器和规则本身。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractDjangoRoutes } from '../src/extract-django-routes.mjs';
import { extractPyRoutes } from '../src/extract-py-routes.mjs';
import { hasInlineGuard, classHasInlineGuard, collectPyGuards, guardMatcher } from '../src/py-guards.mjs';
import { checkPyRules } from '../src/checks/py-rules.mjs';
import { collapseSameLine } from '../src/audit.mjs';

const bench = (name) => path.join(import.meta.dirname, 'benchmark', 'python', name);

function project(t, files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-pyacc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test('Django：urls.py → 视图，守卫（装饰器/Mixin/内联检查）与动态段都解析对', async () => {
  const files = ['manage.py', 'config/__init__.py', 'config/settings.py', 'config/urls.py', 'blog/__init__.py', 'blog/models.py', 'blog/urls.py', 'blog/views.py'];
  const r = await extractDjangoRoutes(bench('django-blog'), files);
  assert.deepEqual(r.warnings, []);
  const by = Object.fromEntries(r.routes.map((x) => [x.path, x]));
  assert.equal(by['/posts/{pk}/edit/'].hasGuard, true, '@login_required');
  assert.equal(by['/posts/{pk}/delete/'].hasGuard, true, 'LoginRequiredMixin');
  assert.equal(by['/drafts/'].hasGuard, false, '没有守卫的类视图');
  assert.equal(by['/export/'].hasGuard, false);
  assert.equal(by['/posts/{pk}/edit/'].method, 'post', '读 request.POST 的视图按写操作算');
  assert.equal(by['/export/'].file, 'blog/views.py', '路由落在视图定义处，不是 urls.py');
});

test('Django：from .views import * 通配导入 + DRF router.register 的 ViewSet', async (t) => {
  const dir = project(t, {
    'app/urls.py': 'from django.urls import path\nfrom rest_framework.routers import DefaultRouter\nfrom .views import *\nfrom .api import NoteViewSet\n\nrouter = DefaultRouter()\nrouter.register("notes", NoteViewSet)\nurlpatterns = [\n    path("start/<int:pk>/", start),\n] + router.urls\n',
    'app/views.py': 'def start(request, pk):\n    if not request.user.is_authenticated:\n        return JsonResponse({"e": 1}, status=401)\n    return JsonResponse({})\n',
    'app/api.py': 'class NoteViewSet(viewsets.ModelViewSet):\n    queryset = Note.objects.all()\n    permission_classes = [IsAuthenticated]\n',
  });
  const r = await extractDjangoRoutes(dir, ['app/urls.py', 'app/views.py', 'app/api.py']);
  assert.deepEqual(r.warnings, []);
  const start = r.routes.find((x) => x.path === '/start/{pk}/');
  assert.ok(start && start.hasGuard, '通配导入的视图找得到，开头的 is_authenticated + 401 算守卫');
  const detail = r.routes.filter((x) => x.path === '/notes/{pk}/');
  assert.ok(detail.length >= 1 && detail.every((x) => x.hasGuard && x.file === 'app/api.py'));
});

test('内联守卫：开头的已登录检查 + 拒绝动作才算；写在中间的分支不算', () => {
  assert.equal(hasInlineGuard(['    if request.user.is_authenticated:', '        return render(r, "x")', '    else:', '        return redirect("login")']), true);
  assert.equal(hasInlineGuard(['    if not current_user:', '        return jsonify({}), 401']), true);
  assert.equal(hasInlineGuard(['    """doc"""', '    if not request.user.is_authenticated:', '        raise PermissionDenied']), true, '跳过 docstring');
  assert.equal(hasInlineGuard(['    x = load()', '    y = 2', '    if not request.user.is_authenticated:', '        return redirect("login")']), false, '第三条语句才检查，不算守卫整个接口');
  assert.equal(hasInlineGuard(['    if request.user.is_authenticated:', '        log("hi")']), false, '没有拒绝动作');
  assert.equal(classHasInlineGuard(['    def get(self, request):', '        if not request.user.is_authenticated:', '            return redirect("login")', '    def post(self, request):', '        return x']), false, '只有 get 有检查');
});

test('项目自定义守卫：@token_required 装饰器、Annotated 依赖别名、DRF @permission_classes', async () => {
  const flask = bench('holdout-flask-bp');
  const g = await collectPyGuards(flask, ['billing/auth.py']);
  assert.ok(g.decorators.has('token_required'));
  const fa = await collectPyGuards(bench('holdout-fastapi-annotated'), ['svc/deps.py']);
  assert.ok(fa.aliases.has('CurrentUser'));
  assert.ok(!fa.aliases.has('SessionDep'), '数据库会话依赖不是鉴权');
  const m = guardMatcher({ decorators: new Set(), aliases: new Set() });
  assert.equal(m('@permission_classes([permissions.IsAuthenticated])'), true);
  assert.equal(m('@permission_classes([permissions.AllowAny])'), false);
  assert.equal(m('@require_POST'), false, 'Django 限制方法的装饰器不是鉴权');
  assert.equal(m('@admin_required'), true);
});

test('Flask add_url_rule + MethodView、aiohttp 路由表都能解析', async () => {
  const r = await extractPyRoutes(bench('blind2-mixed'));
  const key = (x) => `${x.method} ${x.path}`;
  const got = new Map(r.routes.map((x) => [key(x), x]));
  assert.equal(got.get('get /docs/{doc_id}')?.hasGuard, true, 'MethodView 的 decorators = [login_required]');
  assert.equal(got.get('get /admin/stats')?.hasGuard, false);
  assert.equal(got.get('post /admin/reset')?.hasGuard, false, 'aiohttp web.post');
  assert.ok(got.has('post /hooks/github'));
});

test('Python 规则：路径穿越/SSTI/SSRF/CORS/ALLOWED_HOSTS/cookie/JWT 命中，安全写法不报', async () => {
  const want = {
    'flask-shop': ['S5.cors-wildcard@shop/app.py:21', 'S2.py-path-traversal@shop/app.py:99', 'S2.py-ssti@shop/app.py:112', 'S2.py-ssrf@shop/app.py:140'],
    'django-blog': ['S2.py-reflected-xss@blog/views.py:94', 'S5.allowed-hosts-wildcard@config/settings.py:8', 'S5.cors-wildcard@config/settings.py:31', 'S8.py-insecure-cookie@config/settings.py:32'],
    'fastapi-notes': ['S8.jwt-no-verify@app/auth.py:19'],
  };
  for (const [name, expected] of Object.entries(want)) {
    const r = await checkPyRules(bench(name));
    const got = r.findings.map((f) => `${f.rule}@${f.file}:${f.line}`);
    assert.deepEqual([...got].sort(), [...expected].sort(), name);
  }
  // db.session.delete(...) 不是 HTTP 外呼；int 型路由参数不算外部输入
  const extra = await checkPyRules(bench('flask-shop'));
  assert.ok(!extra.findings.some((f) => f.line === 171));
});

test('同位去重：自研规则与 Bandit 同一行只留一条，其余记 relatedRules', () => {
  const out = collapseSameLine([
    { checkId: 'S5', file: 'a.py', line: 9, rule: 'bandit-B201', severity: 'high', force: 'card' },
    { checkId: 'S5', file: 'a.py', line: 9, rule: 'S5.debug-on', severity: 'medium', force: 'card' },
    { checkId: 'S2', file: 'a.py', line: 9, rule: 'S2.x', severity: 'high', force: 'card' },
    { checkId: 'S5', file: '(全仓搜索)', line: 0, rule: 'S5.no-rate-limit', severity: 'medium', force: 'card' },
  ]);
  assert.equal(out.length, 3);
  const s5 = out.find((f) => f.checkId === 'S5' && f.line === 9);
  assert.equal(s5.rule, 'bandit-B201', '严重度高的留下');
  assert.deepEqual(s5.relatedRules, ['S5.debug-on']);
});

test('S6：Python webhook 有 hmac 验签就不报，没验签照报（以前 Python 处理函数喂不了 Babel，一律报）', async () => {
  const { checkExternal } = await import('../src/checks/external.mjs');
  for (const [name, file, expectHit] of [['blind2-mixed', 'hooks/server.py', false], ['django-blog', 'blog/views.py', true]]) {
    const dir = bench(name);
    const r = await checkExternal(dir, { tier: 'L2' });
    const hit = r.findings.some((f) => f.rule === 'S6.webhook-no-verify' && f.file === file);
    assert.equal(hit, expectHit, name);
  }
});
