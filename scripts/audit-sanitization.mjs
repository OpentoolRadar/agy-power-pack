#!/usr/bin/env node
/**
 * @fileoverview Generic repository sanitization, English-only purity, and manifest validator.
 *
 * Uses strictly generic pattern rules (never hardcoding personal tokens or private identifiers)
 * to verify that the repository is clean for public open-source distribution:
 * - Zero CJK / fullwidth characters
 * - Zero host-specific personal home paths (/home/<name>, /Users/<name>, C:\Users\<name>)
 * - Zero private RFC1918 / CGNAT IPv4 addresses
 * - Zero real email addresses (allows RFC 2606 example domains and *.noreply.github.com)
 * - Zero common API token / private key signatures
 * - Valid JSON across all .json files and complete plugin.json manifests
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
]);

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.json',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.py',
  '.sh',
  '.ps1',
  '.html',
  '.css',
  '.svg',
  '.yml',
  '.yaml',
  '.txt',
  '.toml',
]);

const ALLOWED_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'users.noreply.github.com',
]);

const PLACEHOLDER_USERNAMES = new Set([
  'user',
  'username',
  'yourname',
  'your-user',
  'you',
  'alice',
  'bob',
  'runner',
]);

const GENERIC_RULES = [
  {
    id: 'cjk-or-fullwidth',
    description: 'Non-English CJK or fullwidth character detected',
    regex: /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g,
  },
  {
    id: 'unix-home-path',
    description: 'Hardcoded Unix personal home path detected',
    regex: /(?:\/home\/|\/Users\/)([A-Za-z_][A-Za-z0-9._-]*)/g,
    filter: (match) => !PLACEHOLDER_USERNAMES.has(match[1].toLowerCase()),
  },
  {
    id: 'windows-home-path',
    description: 'Hardcoded Windows personal profile path detected',
    regex: /[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)/g,
    filter: (match) => !PLACEHOLDER_USERNAMES.has(match[1].toLowerCase()),
  },
  {
    id: 'private-ipv4',
    description: 'Private or CGNAT IPv4 address detected',
    regex: /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/g,
  },
  {
    id: 'secret-signature',
    description: 'Potential API key, token, or private key material detected',
    regex: /\b(?:ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b|-----BEGIN [A-Z ]+ PRIVATE KEY-----/g,
  },
  {
    id: 'email-address',
    description: 'Non-placeholder email address detected',
    regex: /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    filter: (match) => !ALLOWED_EMAIL_DOMAINS.has(match[1].toLowerCase()),
  },
];

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function isTextFile(filePath) {
  const base = path.basename(filePath);
  if (base === 'LICENSE' || base === '.gitignore') return true;
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function auditFile(filePath) {
  const rel = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const findings = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const rule of GENERIC_RULES) {
      rule.regex.lastIndex = 0;
      let match;
      while ((match = rule.regex.exec(line)) !== null) {
        if (rule.filter && !rule.filter(match)) continue;
        findings.push({
          file: rel,
          line: i + 1,
          rule: rule.id,
          description: rule.description,
          snippet: match[0],
        });
      }
    }
  }
  return findings;
}

function validateJsonAndManifests(files) {
  const errors = [];
  for (const filePath of files) {
    if (path.extname(filePath).toLowerCase() !== '.json') continue;
    const rel = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      if (path.basename(filePath) === 'plugin.json') {
        for (const field of ['name', 'displayName', 'description', 'version', 'logo']) {
          if (!parsed[field] || typeof parsed[field] !== 'string') {
            errors.push(`${rel}: missing or invalid required field "${field}"`);
          }
        }
        if (parsed.logo) {
          const logoPath = path.join(path.dirname(filePath), parsed.logo);
          if (!existsSync(logoPath) || !statSync(logoPath).isFile()) {
            errors.push(`${rel}: declared logo file does not exist (${parsed.logo})`);
          }
        }
      }
    } catch (err) {
      errors.push(`${rel}: invalid JSON (${err.message})`);
    }
  }
  return errors;
}

function main() {
  const allFiles = walkFiles(REPO_ROOT);
  const textFiles = allFiles.filter(isTextFile);
  const findings = [];

  for (const filePath of textFiles) {
    findings.push(...auditFile(filePath));
  }

  const jsonErrors = validateJsonAndManifests(allFiles);

  console.log(`Scanned ${textFiles.length} text files and ${allFiles.filter((f) => f.endsWith('.json')).length} JSON files.`);

  if (findings.length > 0) {
    console.error(`\nSanitization audit FAILED with ${findings.length} finding(s):`);
    for (const f of findings) {
      console.error(`  - ${f.file}:${f.line} [${f.rule}] ${f.description}: "${f.snippet}"`);
    }
  }

  if (jsonErrors.length > 0) {
    console.error(`\nJSON / manifest validation FAILED with ${jsonErrors.length} error(s):`);
    for (const err of jsonErrors) {
      console.error(`  - ${err}`);
    }
  }

  if (findings.length > 0 || jsonErrors.length > 0) {
    process.exit(1);
  }

  console.log('PASS: 0 sanitization findings, 0 CJK/fullwidth leaks, all JSON manifests valid.');
}

main();
