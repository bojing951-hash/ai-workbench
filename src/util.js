// SPDX-License-Identifier: Apache-2.0
/**
 * 通用工具：ID、时间、JSON、敏感信息脱敏、通配符匹配、进程无关的纯函数。
 * 全部零依赖，仅使用 Node 内置模块。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function newId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function writeFileAtomic(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function tryParseJson(text, fallback = null) {
  if (typeof text !== 'string' || !text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 从模型输出中抽取 JSON 对象：支持围栏代码块、前后说明文字、首尾花括号平衡。 */
export function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const direct = tryParseJson(text.trim());
  if (direct !== null) return direct;
  const fence = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const m of fence) {
    const parsed = tryParseJson(m[1].trim());
    if (parsed !== null) return parsed;
  }
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const parsed = tryParseJson(text.slice(start, i + 1));
        if (parsed !== null) return parsed;
        return null;
      }
    }
  }
  return null;
}

export function truncate(str, max = 2000) {
  if (typeof str !== 'string') return '';
  if (str.length <= max) return str;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${str.slice(0, head)}\n... [已截断 ${str.length - max} 字符] ...\n${str.slice(-tail)}`;
}

export function tailLines(text, lines = 80) {
  if (!text) return '';
  const arr = String(text).replace(/\r\n/g, '\n').split('\n');
  return arr.slice(-lines).join('\n');
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/g,
];

/** 对日志/事件做脱敏：既替换配置中的真实密钥值，也按常见 token 形态打码。 */
export function redactSecrets(text, secrets = []) {
  let out = typeof text === 'string' ? text : JSON.stringify(text);
  for (const secret of secrets) {
    if (!secret || typeof secret !== 'string' || secret.length < 6) continue;
    out = out.split(secret).join('***');
  }
  for (const re of SECRET_PATTERNS) out = out.replace(re, '***');
  return out;
}

export function slugify(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'project';
}

export function parseDotenv(content) {
  const out = {};
  for (const raw of String(content).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m${String(sec).padStart(2, '0')}s`;
}

/** 轻量 glob：支持 **、*、?，用于保护路径判断（tests/**、**\/*.test.js 等）。 */
export function globToRegExp(pattern) {
  const p = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const after = p[i + 2];
        if (after === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(file, patterns = []) {
  const normalized = String(file).replace(/\\/g, '/');
  return patterns.some((p) => {
    try {
      return globToRegExp(p).test(normalized);
    } catch {
      return normalized === String(p);
    }
  });
}

export function wildcardMatch(file, patterns) {
  return matchesAny(file, patterns);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function safeFilename(name) {
  return String(name || 'file').replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(0, 80);
}

export function parseList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(/[\n,，;；]+/).map((v) => v.trim()).filter(Boolean);
}
