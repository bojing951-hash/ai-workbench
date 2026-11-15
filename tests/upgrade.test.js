// SPDX-License-Identifier: Apache-2.0
/**
 * 单元测试：src/upgrade.js 候选版本目录（完全离线、临时目录）。
 *
 * P0 要求：自我升级的候选副本不能把宿主敏感内容带进去——`.env`、`data/`（真实 DB/密钥文件）、
 * `projects/`（真实仓库工作副本）、`.git/` 一律不复制；候选副本必须可被 candidateList 读取。
 * 本测试只调用纯文件系统函数，不执行候选测试、不启动候选实例、不占用端口。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCandidate, candidateList, newCandidateId } from '../src/upgrade.js';

/** 写进假 .env 的哨兵值：候选副本里任何文件都不应出现它。 */
const ENV_SECRET_SENTINEL = 'SUPER_SECRET_ENV_VALUE_should_not_be_copied_9f3a';

let tmpRoot;
let sourceRoot;

/** 递归列出目录下的普通文件（不跟随目录符号链接）。 */
function walkFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(abs));
    else if (entry.isFile()) files.push(abs);
    // 符号链接/其它类型不跟随
  }
  return files;
}

/** 构造一个包含敏感目录的假「稳定版本」源码树。 */
function createSourceFixture(root) {
  const dirs = ['src', 'tests', 'data', 'projects/demo-project', '.git', 'node_modules/some-dep', 'docs/images', 'demo/evidence'];
  for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true });

  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'fixture', private: true }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'export const version = 1;\n');
  fs.writeFileSync(path.join(root, 'tests', 'upgrade-fixture.test.js'), '// fixture test\n');
  // 以下内容必须被排除：真实密钥、真实 DB、真实项目工作副本、git 元数据、依赖目录
  fs.writeFileSync(path.join(root, '.env'), `DEEPSEEK_API_KEY=${ENV_SECRET_SENTINEL}\nGITHUB_TOKEN=${ENV_SECRET_SENTINEL}\n`);
  fs.writeFileSync(path.join(root, 'data', 'workbench.db'), 'fake-sqlite-binary');
  fs.writeFileSync(path.join(root, 'data', 'api-token'), ENV_SECRET_SENTINEL);
  fs.writeFileSync(path.join(root, 'projects', 'demo-project', 'app.js'), `const key = '${ENV_SECRET_SENTINEL}';\n`);
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'some-dep', 'index.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(root, 'docs', 'images', 'pic.png'), 'fake-png');
  fs.writeFileSync(path.join(root, 'demo', 'evidence', 'run.json'), '{}');
  fs.writeFileSync(path.join(root, '.DS_Store'), 'ds-store');
}

/** 每个用例使用独立 dataDir，互不干扰。 */
function freshConfig(name) {
  const dataDir = path.join(tmpRoot, `data-${name}`);
  return { paths: { root: sourceRoot, dataDir } };
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-upgrade-test-'));
  sourceRoot = path.join(tmpRoot, 'source');
  createSourceFixture(sourceRoot);
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('createCandidate：候选副本排除敏感内容', () => {
  it('复制源码文件，但不复制 .env / data / projects / .git / node_modules', () => {
    const config = freshConfig('basic');
    const meta = createCandidate({ config, sourceRoot, label: 'p0-upgrade-basic' });

    assert.match(meta.id, /^cand_/);
    assert.equal(meta.label, 'p0-upgrade-basic');
    assert.equal(meta.sourceRoot, sourceRoot);
    assert.equal(path.dirname(meta.dir), path.join(config.paths.dataDir, 'candidates'));
    assert.ok(fs.statSync(meta.dir).isDirectory());

    // 正常源码被完整复制
    for (const rel of ['README.md', 'package.json', 'src/index.js', 'tests/upgrade-fixture.test.js']) {
      assert.ok(fs.existsSync(path.join(meta.dir, rel)), `应复制 ${rel}`);
    }
    assert.equal(fs.readFileSync(path.join(meta.dir, 'src', 'index.js'), 'utf8'), 'export const version = 1;\n');

    // 敏感/无关内容绝不复制
    for (const rel of ['.env', 'data', 'projects', '.git', 'node_modules', '.DS_Store']) {
      assert.equal(fs.existsSync(path.join(meta.dir, rel)), false, `候选副本不应包含 ${rel}`);
    }

    // candidate.json 元数据落盘且与返回对象一致
    const metaFile = path.join(meta.dir, 'candidate.json');
    assert.ok(fs.existsSync(metaFile));
    assert.deepEqual(JSON.parse(fs.readFileSync(metaFile, 'utf8')), meta);
  });

  it('候选副本整树不包含 .env 中的密钥值', () => {
    const config = freshConfig('secrets');
    const meta = createCandidate({ config, sourceRoot, label: 'p0-upgrade-secrets' });
    const files = walkFiles(meta.dir);
    assert.ok(files.length > 0);
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      assert.equal(content.includes(ENV_SECRET_SENTINEL), false, `候选副本泄露了 .env 密钥：${path.relative(meta.dir, file)}`);
    }
  });

  it('源码中的符号链接不会被复制（平台不支持 symlink 则 skip）', (t) => {
    const symlinkSource = path.join(tmpRoot, 'source-symlink');
    fs.mkdirSync(symlinkSource, { recursive: true });
    fs.writeFileSync(path.join(symlinkSource, 'keep.txt'), 'keep\n');
    const outsideTarget = path.join(tmpRoot, 'outside-target.txt');
    fs.writeFileSync(outsideTarget, 'outside secret\n');
    try {
      fs.symlinkSync(outsideTarget, path.join(symlinkSource, 'leak-link.txt'), 'file');
    } catch (err) {
      t.skip(`当前平台/权限不允许创建符号链接（${err.code}），跳过该用例`);
      return;
    }

    const meta = createCandidate({ config: freshConfig('symlink'), sourceRoot: symlinkSource });
    assert.ok(fs.existsSync(path.join(meta.dir, 'keep.txt')));
    assert.equal(fs.existsSync(path.join(meta.dir, 'leak-link.txt')), false);
    // 候选副本里不应出现指向源码树外部的文件
    const copied = walkFiles(meta.dir).filter((f) => !f.endsWith('candidate.json'));
    for (const file of copied) {
      assert.equal(fs.realpathSync(file).startsWith(fs.realpathSync(meta.dir) + path.sep), true);
    }
  });

  it('未提供 label 时默认 label 为 candidate-<id>', () => {
    const meta = createCandidate({ config: freshConfig('label'), sourceRoot });
    assert.equal(meta.label, `candidate-${meta.id}`);
  });
});

describe('candidateList：读取候选清单', () => {
  it('可读取已创建的候选元数据', () => {
    const config = freshConfig('list');
    const first = createCandidate({ config, sourceRoot, label: 'first' });
    const second = createCandidate({ config, sourceRoot, label: 'second' });

    const list = candidateList(config);
    assert.equal(list.length, 2);
    const ids = list.map((c) => c.id).sort();
    assert.deepEqual(ids, [first.id, second.id].sort());
    const fromList = list.find((c) => c.id === first.id);
    assert.deepEqual(fromList, first);
  });

  it('候选目录不存在时返回空数组；无 candidate.json 的多余目录被忽略', () => {
    const emptyConfig = { paths: { root: sourceRoot, dataDir: path.join(tmpRoot, 'data-empty') } };
    assert.deepEqual(candidateList(emptyConfig), []);

    const config = freshConfig('stray');
    createCandidate({ config, sourceRoot, label: 'only' });
    fs.mkdirSync(path.join(config.paths.dataDir, 'candidates', 'not-a-candidate'), { recursive: true });
    fs.writeFileSync(path.join(config.paths.dataDir, 'candidates', 'not-a-candidate', 'random.txt'), 'x');
    assert.equal(candidateList(config).length, 1);
  });

  it('newCandidateId 返回 cand_ 前缀且多次调用不重复', () => {
    const a = newCandidateId();
    const b = newCandidateId();
    assert.match(a, /^cand_/);
    assert.match(b, /^cand_/);
    assert.notEqual(a, b);
  });
});
