import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testProviderConnection } from '../desktop/src/main/provider-test.mjs';

// 最小 fetch 替身：只实现本模块用到的 status/ok/text()
const resp = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const BASE = 'https://gateway.example/v1';

test('测试连接：真发 hi 且有回复才算连通', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/models')) return resp(200, { data: [{ id: 'deepseek-v4.1-flash' }, { id: 'glm-5.3-flash' }] });
    return resp(200, { choices: [{ message: { role: 'assistant', content: '你好！有什么可以帮你？' } }] });
  };
  const r = await testProviderConnection({ baseUrl: BASE + '/', apiKey: 'k', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.model, 'deepseek-v4.1-flash');
  assert.match(r.reply, /你好/);
  assert.equal(r.count, 2);
  const chat = calls.find((c) => c.url.endsWith('/chat/completions'));
  assert.ok(chat, '必须真的调用对话接口');
  const body = JSON.parse(chat.opts.body);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 64);
  assert.equal(chat.opts.headers.authorization, 'Bearer k');
});

test('测试连接：只列得出模型但对话正文为空 → 不算连通', async () => {
  const fetchImpl = async (url) =>
    url.endsWith('/models') ? resp(200, { data: [{ id: 'm1' }] }) : resp(200, { choices: [{ message: { role: 'assistant', content: '' } }] });
  const r = await testProviderConnection({ baseUrl: BASE, apiKey: 'k', fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有返回内容/);
  assert.equal(r.model, 'm1');
});

test('测试连接：认证失败立即报错，不再发对话请求', async () => {
  let n = 0;
  const fetchImpl = async () => { n += 1; return resp(401, { error: { message: 'bad key' } }); };
  const r = await testProviderConnection({ baseUrl: BASE, apiKey: 'k', fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.reason, /认证失败/);
  assert.equal(n, 1);
});

test('测试连接：/models 404 但手填模型且对话成功 → 仍算连通', async () => {
  const fetchImpl = async (url) =>
    url.endsWith('/models') ? resp(404, 'not found') : resp(200, { choices: [{ message: { content: 'hi there' } }] });
  const r = await testProviderConnection({ baseUrl: BASE, apiKey: 'k', model: 'deepseek-v4.1-flash', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.model, 'deepseek-v4.1-flash');
  assert.equal(r.count, 0);
});

test('测试连接：没有模型可用时给可执行提示（不假装连通）', async () => {
  const fetchImpl = async () => resp(404, 'nf');
  const r = await testProviderConnection({ baseUrl: BASE, apiKey: 'k', fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有可用模型/);
  assert.match(r.hint, /添加一个模型名称/);
});

test('测试连接：对话接口报错时把网关错误信息带出来', async () => {
  const fetchImpl = async (url) =>
    url.endsWith('/models') ? resp(200, { data: [{ id: 'm1' }] }) : resp(404, { error: { message: 'model not found: m1' } });
  const r = await testProviderConnection({ baseUrl: BASE, apiKey: 'k', fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.reason, /HTTP 404/);
  assert.match(r.hint, /model not found/);
});

test('测试连接：对话超时（AbortError）给人话提示', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/models')) return resp(200, { data: [{ id: 'm1' }] });
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  };
  const r = await testProviderConnection({ baseUrl: BASE, apiKey: 'k', fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.reason, /超时/);
});

test('测试连接：Base URL 非法时不发请求', async () => {
  let n = 0;
  const r = await testProviderConnection({ baseUrl: 'not a url', fetchImpl: async () => { n += 1; return resp(200, {}); } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /不是合法 URL/);
  assert.equal(n, 0);
});
