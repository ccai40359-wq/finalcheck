// 工具参数 JSON 错误的英文界面：错误卡片/状态行不能回退中文。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage, t, hasTranslation } from '../desktop/src/renderer/i18n/core.mjs';

const CJK = /[\u3400-\u9fff]/;

const KEYS = [
  '（第 {pos} 字符附近）',
  '工具参数被输出长度上限截断{posHint}，本次调用未执行',
  '工具参数不是合法 JSON{posHint}，本次调用未执行',
  '你上一次的工具调用「{name}」参数被输出长度上限截断了（{code}），这些调用没有执行。',
  '你上一次的工具调用「{name}」参数不是合法 JSON（{code}），这个调用没有执行。',
  '解析失败位置：{pos}；参数总长：{chars} 字符。',
  '第 {n} 个字符',
  '错误位置附近片段：{snippet}',
  '请把参数拆小/缩短后重新发起这一个工具调用（例如减少 steps、精简 prompt、改成分步调用）。',
  '请只重新发起这一个工具调用，参数必须是合法 JSON：键值之间必须有冒号，字段之间必须有逗号，字符串里的引号要转义；参数太长时请拆小。',
  '本轮工具参数被输出上限截断（{code}），已自动重发一次（未执行）。',
  '工具参数不是合法 JSON（{code}）：{tools} 未执行，已把解析错误回给模型重发一次。',
  '工具参数连续两次不是合法 JSON（{code}），本轮已停止，{tools} 没有执行。可重试本步，或让模型把参数拆小后重新发起。常见原因：Windows 路径写成单反斜杠；请改用 D:/... 或 D:\\\\...（JSON 里反斜杠必须双写）。',
  '工具参数连续两次被输出上限截断（{code}），本轮已停止，这些调用没有执行。建议把参数拆小（减少 steps / 精简 prompt）后重试本步。',
  '工具参数被截断，正在重发…',
  '工具参数有误，正在让模型重发…'
];

after(() => { setLanguage('zh'); });

test('i18n: 工具参数 JSON 错误在英文界面全部有英文译文', () => {
  setLanguage('en');
  for (const key of KEYS) {
    assert.ok(hasTranslation(key), `缺英文译文：${key}`);
    const en = t(key);
    assert.ok(en.trim(), `英文译文为空：${key}`);
    assert.ok(!CJK.test(en), `英文译文仍含中文：${key} → ${en}`);
    assert.notEqual(en, key, `英文译文回退成中文原文：${key}`);
  }
});

test('i18n: 工具参数错误在中文界面仍返回原文', () => {
  setLanguage('zh');
  for (const key of KEYS) assert.equal(t(key), key);
});
