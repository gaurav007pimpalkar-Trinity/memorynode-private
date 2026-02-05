import fs from 'node:fs';
import path from 'node:path';

const entryPath = path.join('apps', 'api', 'src', 'index.ts');
const content = fs.readFileSync(entryPath, 'utf8');

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

const missingMarkers = requiredMarkers.filter((m) => !content.includes(m));
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
