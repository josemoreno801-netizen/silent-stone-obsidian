#!/usr/bin/env node
// Syncs manifest.json and versions.json with package.json version.
// Run as part of the `version` lifecycle hook during `npm version <bump>`.
// npm sets npm_package_version to the new version after bumping package.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const manifestPath = resolve(pluginRoot, 'manifest.json');
const versionsPath = resolve(pluginRoot, 'versions.json');

const newVersion = process.env.npm_package_version;
if (!newVersion) {
  console.error('sync-version: npm_package_version not set. Run via `npm version <bump>`, not directly.');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const versions = JSON.parse(readFileSync(versionsPath, 'utf8'));
const minAppVersion = manifest.minAppVersion;

manifest.version = newVersion;
versions[newVersion] = minAppVersion;

writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
writeFileSync(versionsPath, JSON.stringify(versions, null, '\t') + '\n');

console.log(`sync-version: bumped to ${newVersion} (minAppVersion ${minAppVersion})`);
