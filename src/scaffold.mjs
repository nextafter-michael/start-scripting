/**
 * scaffold.mjs — Creates new experiences, variations, and modification blocks
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Convert a display name to a filesystem-safe slug.
 * e.g. "Homepage Hero Test!" → "homepage-hero-test"
 */
export function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Write (or overwrite) the hidden esbuild entry file for an experience + variation.
 * Lives in dist/entry/<expSlug>.js — outside the experience folder so users never see it.
 *
 * Reads config.json to determine the correct import order for modification blocks.
 *
 * @param {string} expSlug - e.g. "homepage-hero"
 * @param {string} varSlug - e.g. "variation-1"
 */
export function writeCacheEntry(expSlug, varSlug) {
  const cacheDir = join(process.cwd(), 'dist/entry');
  mkdirSync(cacheDir, { recursive: true });

  const configPath = join(process.cwd(), 'config.json');
  let imports = '';

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const exp = config.experiences?.find((e) => e.slug === expSlug);
    const variation = exp?.variations?.find((v) => v.slug === varSlug);

    if (variation?.modifications?.length) {
      const lines = [];
      for (const mod of variation.modifications) {
        if (!mod?.slug) continue; // skip malformed entries without a slug
        const blockPath = `experiences/${expSlug}/${varSlug}/${mod.slug}`;
        // CSS first so styles are registered before the JS runs
        // Note: dist/entry/ is two levels deep, so ../../ returns to project root
        if (mod.resources?.includes('modification.css')) {
          lines.push(`import '../../${blockPath}/modification.css';`);
        }
        if (mod.resources?.includes('modification.js')) {
          lines.push(`import '../../${blockPath}/modification.js';`);
        }
      }
      imports = lines.join('\n');
    }
  } catch {}

  const content = imports || `// ${expSlug}/${varSlug} — no modifications defined`;
  writeFileSync(join(cacheDir, `${expSlug}.js`), content + '\n');
}

/**
 * Create a new experience: adds it to config.json and makes the directory.
 * Automatically adds a Control variation (JSON-only, no directory).
 * Sets the experience as active if no active experience exists yet.
 *
 * @param {string} name - Display name (e.g. "Homepage Hero")
 * @returns {string} The generated slug
 */
export function scaffoldExperience(name) {
  const slug = slugify(name);
  const expDir = join(process.cwd(), 'experiences', slug);

  const configPath = join(process.cwd(), 'config.json');
  let config = { $schema: 'https://nextafter.com/ss/config-schema.json', active: {}, experiences: [], settings: {} };
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {}

  if (!config.experiences) config.experiences = [];
  if (!config.active) config.active = {};

  // Guard against duplicate slugs in both the directory and config
  if (existsSync(expDir) || config.experiences.some((e) => e.slug === slug)) {
    console.error(`✖ Experience already exists: ${slug}`);
    process.exit(1);
  }

  mkdirSync(expDir, { recursive: true });

  config.experiences.push({
    name,
    slug,
    pages: { editor: '', include: [], exclude: [] },
    variations: [{ name: 'Control', slug: 'control' }],
    audiences: [],
  });

  // Set as active if nothing is active yet
  if (!config.active.experience) {
    config.active.experience = slug;
    config.active.variation = 'control';
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2));

  console.log(`✔ Created experience: ${name}`);
  console.log(`  experiences/${slug}/`);

  return slug;
}

/**
 * Create a new variation for an experience: adds it to config.json and
 * makes the directory. Sets it as the active variation.
 *
 * @param {string} expSlug - Experience slug (e.g. "homepage-hero")
 * @param {string} varName - Display name (e.g. "Variation 1")
 * @returns {string} The generated slug
 */
export function scaffoldVariation(expSlug, varName) {
  const varSlug = slugify(varName);
  const varDir = join(process.cwd(), 'experiences', expSlug, varSlug);

  const configPath = join(process.cwd(), 'config.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const exp = config.experiences?.find((e) => e.slug === expSlug);
    if (exp) {
      if (!exp.variations) exp.variations = [];

      // Guard against duplicate slugs in both directory and config
      if (existsSync(varDir) || exp.variations.some((v) => v.slug === varSlug)) {
        console.error(`✖ Variation already exists: ${expSlug}/${varSlug}`);
        process.exit(1);
      }

      mkdirSync(varDir, { recursive: true });
      exp.variations.push({ name: varName, slug: varSlug, modifications: [] });

      // Set as active variation
      if (!config.active) config.active = {};
      config.active.experience = expSlug;
      config.active.variation = varSlug;

      writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
  } catch (err) {
    console.warn(`  ⚠ Could not update config.json: ${err.message}`);
  }

  writeCacheEntry(expSlug, varSlug);

  console.log(`✔ Created variation: ${varName}`);
  console.log(`  experiences/${expSlug}/${varSlug}/`);

  return varSlug;
}

/**
 * Create a new modification block: makes the directory + files and adds
 * it to the variation's modifications array in config.json.
 *
 * @param {string} expSlug   - Experience slug
 * @param {string} varSlug   - Variation slug
 * @param {string} blockName - Display name for the block (e.g. "Hero Copy Change")
 * @returns {string[]} The resource filenames created
 */
export function scaffoldBlock(expSlug, varSlug, blockName) {
  const blockSlug = slugify(blockName);
  const blockDir = join(process.cwd(), 'experiences', expSlug, varSlug, blockSlug);

  if (existsSync(blockDir)) {
    console.error(`✖ Block already exists: experiences/${expSlug}/${varSlug}/${blockSlug}/`);
    process.exit(1);
  }

  mkdirSync(blockDir, { recursive: true });
  writeFileSync(join(blockDir, 'modification.js'), '');
  writeFileSync(join(blockDir, 'modification.css'), '');
  writeFileSync(join(blockDir, 'modification.html'), '');

  const resources = ['modification.css', 'modification.js', 'modification.html'];

  const configPath = join(process.cwd(), 'config.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const exp = config.experiences?.find((e) => e.slug === expSlug);
    const variation = exp?.variations?.find((v) => v.slug === varSlug);
    if (variation) {
      if (!variation.modifications) variation.modifications = [];
      variation.modifications.push({
        name: blockName,
        slug: blockSlug,
        trigger: 'DOM_READY',
        resources,
      });
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
  } catch (err) {
    console.warn(`  ⚠ Could not update config.json: ${err.message}`);
  }

  writeCacheEntry(expSlug, varSlug);

  console.log(`✔ Created modification block: ${blockName}`);
  console.log(`  experiences/${expSlug}/${varSlug}/${blockSlug}/`);
  console.log(`  Edit ${blockSlug}/modification.js to write your code`);

  return resources;
}
