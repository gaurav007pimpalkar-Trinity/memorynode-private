import fs from 'node:fs';
import path from 'node:path';

const srcDir = path.join('apps', 'api', 'src');
const entryPath = path.join(srcDir, 'index.ts');
const content = fs.readFileSync(entryPath, 'utf8');

// Phase 2: types may live in index.ts (monolith) or in modules (workerApp, http, auth)
function readFileSafe(rel) {
  try {
    return fs.readFileSync(path.join(srcDir, rel), 'utf8');
  } catch {
    return '';
  }
}
const allContent = [
  content,
  readFileSafe('workerApp.ts'),
  readFileSafe('http.ts'),
  readFileSafe('auth.ts'),
  readFileSafe(path.join('handlers', 'memories.ts')),
].join('\n');

const requiredMarkers = [
  'interface ApiError',
  'interface AuthContext',
  'type MetadataFilter',
];
const compiledMarkers = [
  'exports.__esModule',
  'Object.defineProperty(exports',
  'var __defProp',
  '"use strict"',
  "'use strict'",
];

const missingMarkers = requiredMarkers.filter((m) => !allContent.includes(m));
const hasCompiledMarkers = compiledMarkers.some((m) => content.includes(m));

if (missingMarkers.length || hasCompiledMarkers) {
  console.error('check:typed-entry failed for', entryPath);
  if (missingMarkers.length) {
    console.error('Missing TS markers:', missingMarkers.join(', '));
  }
  if (hasCompiledMarkers) {
    console.error('Detected compiled JS markers (please restore typed source).');
  }
  process.exit(1);
}

console.log('check:typed-entry passed:', entryPath);
