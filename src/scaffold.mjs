/**
 * scaffold.mjs — Creates a new test folder from the _template
 */

import { cpSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// TOOL_DIR: where the ss tool is installed — used to find the _template folder
const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Copy the _template folder to tests/<testName>/ in the current working directory.
 *
 * @param {string} testName - Folder name for the new test (e.g. "homepage-hero")
 */
export function scaffoldTest(testName) {
  // Template always comes from the tool's install, not the current project
  const templateDir = join(TOOL_DIR, 'tests', '_template');
  // Test is created in the current project (wherever the user ran ss from)
  const testDir = join(process.cwd(), 'tests', testName);

  if (existsSync(testDir)) {
    console.error(`✖ tests/${testName}/ already exists.`);
    process.exit(1);
  }

  cpSync(templateDir, testDir, { recursive: true });

  console.log(`✔ Created tests/${testName}/`);
  console.log(`\n  Edit tests/${testName}/variation.js to write your test code.`);
}
