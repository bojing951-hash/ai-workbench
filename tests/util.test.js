// SPDX-License-Identifier: Apache-2.0
/**
 * 单元测试：src/util.js 纯函数（零外部依赖、完全离线）。
 * 覆盖：extractJson / globToRegExp+matchesAny / parseDotenv / redactSecrets / truncate / parseList。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractJson,
  globToRegExp,
  matchesAny,
  wildcardMatch,
  parseDotenv,
  redactSecrets,
  truncate,
  parseList,
  newId,
  slugify,
  toBool,
  clamp,
  safeFilename,
  tailLines,
} from '../src/util.js';

describe('extractJson：从模型输出中稳健抽取 JSON', () => {
  it('纯 JSON 文本直接解析', () => {
    assert.deepEqual(extractJson('{"verdict":"pass","score":95}'), { verdict: 'pass', score: 95 });
    assert.deepEqual(extractJson('  \n {"a":1} \n '), { a: 1 });
  });

  it('解析 ```json 围栏代码块（含前后说明文字）', () => {
    const text = '审计结论如下：\n```json\n{"verdict":"fail","findings":[]}\n```\n以上。';
    assert.deepEqual(extractJson(text), { verdict: 'fail', findings: [] });
  });

  it('解析无语言标注的围栏代码块', () => {
    const text = '```\n{"ok":true,"n":2}\n```';
    assert.deepEqual(extractJson(text), { ok: true, n: 2 });
  });

  it('无围栏但夹杂说明文字时，按首尾花括号平衡抽取对象', () => {
    const text = '我已完成审查。结论：{"criteria":[{"criterion":"a","status":"pass"}]} 请复核。';
    assert.deepEqual(extractJson(text), { criteria: [{ criterion: 'a', status: 'pass' }] });
  });

  it('正确跳过字符串内部的 } 与 {', () => {
    const text = '结果：{"note":"字符串里有 } 和 { 不算括号","n":1} end';
    assert.deepEqual(extractJson(text), { note: '字符串里有 } 和 { 不算括号', n: 1 });
  });

  it('第一个围栏非法时继续尝试后续围栏', () => {
    const text = '```\nnot json at all\n```\n```json\n{"ok":true}\n```';
    assert.deepEqual(extractJson(text), { ok: true });
  });

  it('非法 / 空输入返回 null', () => {
    assert.equal(extractJson('这完全不是 JSON'), null);
    assert.equal(extractJson('{"a":'), null);
    assert.equal(extractJson(''), null);
    assert.equal(extractJson('   '), null);
    assert.equal(extractJson(null), null);
    assert.equal(extractJson(undefined), null);
    assert.equal(extractJson(42), null);
  });

  it('纯 JSON 数组按直接解析返回数组', () => {
    assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3]);
  });
});

describe('globToRegExp / matchesAny：保护路径通配符', () => {
  it('tests/** 匹配目录下任意深度文件', () => {
    assert.ok(globToRegExp('tests/**') instanceof RegExp);
    assert.ok(matchesAny('tests/a.test.js', ['tests/**']));
    assert.ok(matchesAny('tests/unit/deep/file.js', ['tests/**']));
    assert.equal(matchesAny('src/tests/a.js', ['tests/**']), false);
  });

  it('**/*.test.js 匹配任意深度（含根目录）', () => {
    assert.ok(matchesAny('x.test.js', ['**/*.test.js']));
    assert.ok(matchesAny('src/x.test.js', ['**/*.test.js']));
    assert.ok(matchesAny('a/b/c/x.test.js', ['**/*.test.js']));
    assert.equal(matchesAny('src/x.test.mjs', ['**/*.test.js']), false);
  });

  it('精确路径只匹配自身，正则元字符被转义', () => {
    assert.ok(matchesAny('src/index.js', ['src/index.js']));
    assert.equal(matchesAny('src/index.js.bak', ['src/index.js']), false);
    assert.ok(matchesAny('a.b.js', ['a.b.js']));
    assert.equal(matchesAny('axb.js', ['a.b.js']), false);
  });

  it('? 精确匹配单个非分隔符字符，* 不跨目录', () => {
    assert.ok(matchesAny('src/a1.js', ['src/a?.js']));
    assert.equal(matchesAny('src/a12.js', ['src/a?.js']), false);
    assert.ok(matchesAny('src/a.js', ['src/*.js']));
    assert.equal(matchesAny('src/sub/a.js', ['src/*.js']), false);
  });

  it('反斜杠路径被规范化，多模式任一命中即可', () => {
    assert.ok(matchesAny('tests\\unit\\a.js', ['tests/**']));
    assert.ok(matchesAny('acceptance/case1.md', ['tests/**', 'acceptance/**']));
    assert.equal(matchesAny('README.md', ['tests/**', 'acceptance/**']), false);
  });

  it('空模式 / 非法模式不抛异常', () => {
    assert.equal(matchesAny('anything', []), false);
    assert.equal(matchesAny('anything', undefined), false);
    assert.equal(wildcardMatch('a/b', ['a/**']), true);
  });
});

describe('parseDotenv：.env 解析', () => {
  it('解析键值、注释、引号与含 = 的值', () => {
    const content = [
      '# 注释行会被忽略',
      '',
      '   ',
      'A=1',
      'B = two words ',
      'C="quoted value"',
      "D='single quoted'",
      'E=a=b=c',
      'F=',
      'NOEQ_LINE',
      '  # 缩进的注释',
    ].join('\n');
    assert.deepEqual(parseDotenv(content), {
      A: '1',
      B: 'two words',
      C: 'quoted value',
      D: 'single quoted',
      E: 'a=b=c',
      F: '',
    });
  });

  it('空内容返回空对象', () => {
    assert.deepEqual(parseDotenv(''), {});
    assert.deepEqual(parseDotenv('\n\n# only comment\n'), {});
  });
});

describe('redactSecrets：敏感信息脱敏', () => {
  it('按常见 token 形态打码（sk- / Bearer）', () => {
    const raw = 'api_key=sk-abcdefghijklmnop123456, Authorization: Bearer abcdefghijklmnop1234';
    const out = redactSecrets(raw);
    assert.ok(!out.includes('sk-abcdefghijklmnop123456'));
    assert.ok(!out.includes('abcdefghijklmnop1234'));
    assert.ok(out.includes('***'));
  });

  it('替换配置中显式提供的密钥值（长度 >= 6 才处理）', () => {
    assert.equal(redactSecrets('token=supersecretvalue', ['supersecretvalue']), 'token=***');
    assert.equal(redactSecrets('token=abc', ['abc']), 'token=abc');
  });

  it('对象输入先序列化再脱敏', () => {
    const out = redactSecrets({ key: 'sk-abcdefghijklmnop', note: '正常文本' });
    assert.ok(!out.includes('sk-abcdefghijklmnop'));
    assert.ok(out.includes('正常文本'));
  });

  it('普通文本保持不变', () => {
    assert.equal(redactSecrets('没有密钥的日志行'), '没有密钥的日志行');
  });
});

describe('truncate：长文本截断', () => {
  it('短文本原样返回', () => {
    assert.equal(truncate('hello', 100), 'hello');
    assert.equal(truncate('hello', 5), 'hello');
  });

  it('长文本保留头尾并标注截断字符数', () => {
    const long = 'a'.repeat(100);
    const out = truncate(long, 20);
    assert.notEqual(out, long);
    assert.ok(out.includes('已截断 80 字符'));
    assert.ok(out.startsWith('a'.repeat(15)));
    assert.ok(out.endsWith('a'.repeat(5)));
  });

  it('非字符串返回空串', () => {
    assert.equal(truncate(null), '');
    assert.equal(truncate(undefined), '');
    assert.equal(truncate(123), '');
  });
});

describe('parseList：列表输入归一化', () => {
  it('数组去空白与空项', () => {
    assert.deepEqual(parseList([' a ', '', 'b', '  ']), ['a', 'b']);
  });

  it('字符串按换行 / 中英文逗号 / 中英文分号切分并去空白', () => {
    assert.deepEqual(parseList('a,b，c;d；e\nf'), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.deepEqual(parseList('  x  \n\n y , '), ['x', 'y']);
  });

  it('空值与非字符串非数组返回空数组', () => {
    assert.deepEqual(parseList(''), []);
    assert.deepEqual(parseList(undefined), []);
    assert.deepEqual(parseList(null), []);
    assert.deepEqual(parseList(42), []);
    assert.deepEqual(parseList({}), []);
  });
});

describe('util 其他纯函数（回归保护）', () => {
  it('newId 带前缀且足够唯一', () => {
    const id = newId('run');
    assert.match(id, /^run_[a-z0-9]+$/);
    const set = new Set(Array.from({ length: 200 }, () => newId('x')));
    assert.equal(set.size, 200);
  });

  it('slugify 处理中文与符号', () => {
    assert.equal(slugify('  My Project!! '), 'my-project');
    assert.equal(slugify('项目 A/B'), '项目-a-b');
    assert.equal(slugify(''), 'project');
  });

  it('toBool 与 clamp', () => {
    assert.equal(toBool(undefined, true), true);
    assert.equal(toBool('yes'), true);
    assert.equal(toBool('0'), false);
    assert.equal(toBool(true), true);
    assert.equal(clamp(5, 0, 3), 3);
    assert.equal(clamp(-1, 0, 3), 0);
  });

  it('safeFilename 与 tailLines', () => {
    assert.equal(safeFilename('a b/c:*?.txt'), 'a_b_c_.txt');
    assert.equal(tailLines('1\n2\n3', 2), '2\n3');
    assert.equal(tailLines('', 2), '');
  });
});
