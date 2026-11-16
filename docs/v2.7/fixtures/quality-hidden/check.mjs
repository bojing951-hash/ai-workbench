// v2.7 hidden quality checks for Reading Queue Planner. This file is intentionally OUTSIDE the product repo.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const out = { requirements: [], issues: [] };
function add(id, status, evidence, issues = []) { out.requirements.push({ id, status, evidence, issues }); issues.forEach((i) => out.issues.push(i)); }
async function load(rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) throw new Error(`缺少文件 ${rel}`);
  return import(pathToFileURL(file).href + `?t=${Date.now()}`);
}
try {
  const lib = await load('src/library.js');
  const books = [];
  lib.addBook(books, { title: 'Dune', author: 'Herbert', pages: 500, priority: 5 });
  let ok = false;
  try { lib.addBook(books, { title: 'Dune', author: 'Herbert', pages: 500, priority: 5 }); } catch { ok = true; }
  if (!ok) add('R1', 'fail', '隐藏检查：重复 title/author 没有拒绝', [{ id: 'Q-R1-dup', title: '重复书籍未拒绝', priority: 'P1', evidence: 'addBook 两次相同 title/author 未抛错' }]);
  else add('R1', 'pass', '隐藏检查：添加/重复拒绝通过');
} catch (e) { add('R1', 'fail', e.message, [{ id: 'Q-R1-missing', title: '书籍管理未实现', priority: 'P0', evidence: e.message }]); }
try {
  const planner = await load('src/planner.js');
  const books = [
    { id: 'a', title: 'A', author: 'x', pages: 100, priority: 5, done: false, available: true },
    { id: 'b', title: 'B', author: 'x', pages: 100, priority: 5, done: false, available: true },
    { id: 'done', title: 'D', author: 'x', pages: 10, priority: 5, done: true, available: true },
    { id: 'no', title: 'N', author: 'x', pages: 10, priority: 5, done: false, available: false },
  ];
  const res = planner.buildPlan(books, 60, 1, { minutesPerPage: 1 });
  const ids = res.plan.map((s) => s.bookId || s.id);
  const dup = new Set(ids).size !== ids.length;
  const includesForbidden = ids.includes('done') || ids.includes('no');
  if (dup || includesForbidden || !Array.isArray(res.unplanned) || !res.unplanned.some((u) => u.bookId === 'a')) {
    add('R2', 'fail', '隐藏检查：计划重复/包含完成或不可用/缺少 unplanned', [{ id: 'Q-R2-plan', title: '阅读计划边界错误', priority: 'P0', evidence: JSON.stringify(res).slice(0, 500) }]);
  } else add('R2', 'pass', '隐藏检查：优先级/去重/完成与否/unplanned 通过');
} catch (e) { add('R2', 'fail', e.message, [{ id: 'Q-R2-missing', title: '阅读计划未实现', priority: 'P0', evidence: e.message }]); }
try {
  const store = await load('src/store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rqp-hidden-'));
  const file = path.join(dir, 'lib.json');
  const data = [{ id: '1', title: 'T', author: 'A', pages: 10, priority: 3, done: false, available: true }];
  store.saveLibrary(file, data);
  const loaded = store.loadLibrary(file);
  fs.writeFileSync(file, '{broken');
  let corrupt = false;
  try { store.loadLibrary(file); } catch { corrupt = true; }
  if (JSON.stringify(loaded) !== JSON.stringify(data) || !corrupt) add('R3', 'fail', '隐藏检查：持久化往返或损坏文件处理错误', [{ id: 'Q-R3-store', title: '本地持久化错误', priority: 'P1', evidence: '往返不等或损坏 JSON 未抛错' }]);
  else add('R3', 'pass', '隐藏检查：持久化与损坏文件错误通过');
} catch (e) { add('R3', 'fail', e.message, [{ id: 'Q-R3-missing', title: '持久化未实现', priority: 'P1', evidence: e.message }]); }
try {
  if (!fs.existsSync(path.join(root, 'src/cli.js'))) throw new Error('缺少 src/cli.js');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rqp-cli-')), 'lib.json');
  fs.writeFileSync(file, JSON.stringify([]));
  const r = spawnSync(process.execPath, ['src/cli.js', 'plan', '--minutes', '30', '--days', '7', '--file', file], { cwd: root, encoding: 'utf8' });
  const parsed = JSON.parse(r.stdout || '{}');
  if (r.status !== 0 || !Array.isArray(parsed.plan) || !Array.isArray(parsed.unplanned) || typeof parsed.totalMinutes !== 'number') throw new Error(`CLI 输出无效 exit=${r.status}`);
  add('R4', 'pass', '隐藏检查：CLI plan JSON 输出通过');
} catch (e) { add('R4', 'fail', e.message, [{ id: 'Q-R4-cli', title: 'CLI 用户流程未通过', priority: 'P1', evidence: e.message }]); }
console.log(JSON.stringify(out));
