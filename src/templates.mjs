/**
 * templates.mjs — init-wizard logic for ss init --template=<name>
 *
 * Each template exports an async `run(projectDir, prompt, helpers)` function
 * that drives the interactive wizard, creates directories and files, and
 * returns the final config object to be written to config.json.
 *
 * helpers: { slugify, writeCacheEntry, scaffoldBlock, writeFileSync, mkdirSync, join, existsSync }
 */

// ─── Trigger catalogue ────────────────────────────────────────────────────────
//
// Generic cross-platform triggers (work in any template):
//   IMMEDIATE, DOM_READY, ELEMENT_LOADED, AFTER_CODE_BLOCK
//
// VWO-namespaced triggers (alias the generic ones exactly):
//   VWO:IMMEDIATE, VWO:DOM_READY, VWO:ELEMENT_LOADED, VWO:AFTER_CODE_BLOCK
//
// GTM-specific triggers (metadata only — execution is handled by GTM at export):
//   GTM:INITIALIZATION, GTM:CONTAINER_LOADED, GTM:PAGE_VIEW,
//   GTM:DOM_READY, GTM:WINDOW_LOADED, GTM:CUSTOM_EVENT,
//   GTM:FORM_SUBMIT, GTM:CLICK, GTM:ELEMENT_VISIBILITY, GTM:SCROLL
//
// Adobe Target triggers:
//   AT:IMMEDIATE, AT:DOM_READY, AT:ELEMENT_LOADED

export const TRIGGER_GROUPS = {
  generic: ['IMMEDIATE', 'DOM_READY', 'ELEMENT_LOADED', 'AFTER_CODE_BLOCK'],
  vwo:     ['VWO:IMMEDIATE', 'VWO:DOM_READY', 'VWO:ELEMENT_LOADED', 'VWO:AFTER_CODE_BLOCK'],
  gtm:     [
    'GTM:INITIALIZATION', 'GTM:CONTAINER_LOADED', 'GTM:PAGE_VIEW',
    'GTM:DOM_READY', 'GTM:WINDOW_LOADED', 'GTM:CUSTOM_EVENT',
    'GTM:FORM_SUBMIT', 'GTM:CLICK', 'GTM:ELEMENT_VISIBILITY', 'GTM:SCROLL',
  ],
  at:      ['AT:IMMEDIATE', 'AT:DOM_READY', 'AT:ELEMENT_LOADED'],
};

/** All valid trigger strings across every template. */
export const ALL_TRIGGERS = [
  ...TRIGGER_GROUPS.generic,
  ...TRIGGER_GROUPS.vwo,
  ...TRIGGER_GROUPS.gtm,
  ...TRIGGER_GROUPS.at,
];

/**
 * Triggers that need a CSS selector sub-field (like ELEMENT_LOADED).
 * Keyed as a Set for fast lookup.
 */
export const SELECTOR_TRIGGERS = new Set([
  'ELEMENT_LOADED', 'VWO:ELEMENT_LOADED', 'AT:ELEMENT_LOADED',
  'GTM:ELEMENT_VISIBILITY',
]);

/**
 * Triggers that need an event name sub-field.
 */
export const EVENT_TRIGGERS = new Set([
  'GTM:CUSTOM_EVENT', 'GTM:FORM_SUBMIT', 'GTM:CLICK', 'GTM:SCROLL',
]);

/**
 * Map a trigger string to which "extras" sub-UI it needs.
 *   'selector'   → CSS selector input
 *   'dependency' → AFTER_CODE_BLOCK dependency dropdown
 *   'event'      → GTM event name input
 *   null         → no extras
 */
export function triggerExtras(trigger) {
  if (SELECTOR_TRIGGERS.has(trigger))            return 'selector';
  if (trigger === 'AFTER_CODE_BLOCK' || trigger === 'VWO:AFTER_CODE_BLOCK') return 'dependency';
  if (EVENT_TRIGGERS.has(trigger))               return 'event';
  return null;
}

// ─── Runtime equivalence ──────────────────────────────────────────────────────
//
// VWO and AT namespaced triggers behave identically to their generic counterparts
// at runtime (the client-side _trigger() function). GTM triggers are treated as
// IMMEDIATE in the proxy preview (since GTM tag firing is not emulated) and are
// only meaningful for the eventual export step.

export const RUNTIME_TRIGGER_MAP = {
  'VWO:IMMEDIATE':      'IMMEDIATE',
  'VWO:DOM_READY':      'DOM_READY',
  'VWO:ELEMENT_LOADED': 'ELEMENT_LOADED',
  'VWO:AFTER_CODE_BLOCK': 'AFTER_CODE_BLOCK',
  'AT:IMMEDIATE':       'IMMEDIATE',
  'AT:DOM_READY':       'DOM_READY',
  'AT:ELEMENT_LOADED':  'ELEMENT_LOADED',
  // GTM triggers → preview as DOM_READY so the code actually runs in the proxy
  'GTM:INITIALIZATION':    'IMMEDIATE',
  'GTM:CONTAINER_LOADED':  'DOM_READY',
  'GTM:PAGE_VIEW':         'DOM_READY',
  'GTM:DOM_READY':         'DOM_READY',
  'GTM:WINDOW_LOADED':     'DOM_READY',
  'GTM:CUSTOM_EVENT':      'DOM_READY',
  'GTM:FORM_SUBMIT':       'DOM_READY',
  'GTM:CLICK':             'DOM_READY',
  'GTM:ELEMENT_VISIBILITY':'ELEMENT_LOADED',
  'GTM:SCROLL':            'DOM_READY',
};

/** Resolve a stored trigger to its runtime equivalent for the _trigger() call. */
export function runtimeTrigger(trigger) {
  return RUNTIME_TRIGGER_MAP[trigger] || trigger;
}

// ─── Template notes (stored in config.json as settings.template_notes) ────────
export const TEMPLATE_EXPORT_NOTES = {
  gtm: [
    'Export: wrap JS in <script type="text/gtmscript"> tags.',
    'Export: wrap CSS in <style> tags.',
    'GTM trigger types are metadata — set them on the GTM tag after export.',
  ],
  at: [
    'Export: wrap JS in <script type="text/javascript"> tags.',
    'Export: wrap CSS in <style> tags.',
    'Export: replace `${variable}` with ` + variable + ` (Adobe Target does not support template literals with interpolation).',
    'Modifications are injected at a selector position or in <head>/<body>.',
  ],
  vwo: [
    'Resource order is always CSS → JS → HTML per VWO convention.',
    'Export via the VWO custom code editor.',
  ],
};

// ─── VWO template ─────────────────────────────────────────────────────────────

export async function runVwoWizard(projectDir, prompt, helpers) {
  const { slugify, writeCacheEntry, writeFileSync, mkdirSync, join } = helpers;

  console.log('\n  Template: VWO (Visual Website Optimizer)\n');

  const siteUrl = await prompt('  Site URL (press Enter to skip):       ');
  const expName = await prompt('  Experience / test name:               ');
  if (!expName.trim()) {
    console.error('✖ Experience name is required.');
    process.exit(1);
  }

  const numVarsRaw = await prompt('  Number of variations (not counting Control): ');
  const numVars = Math.max(0, parseInt(numVarsRaw, 10) || 0);

  const expSlug = slugify(expName);

  const variations = [{ name: 'Control', slug: 'control' }];
  const varSlugs = [];

  for (let i = 1; i <= numVars; i++) {
    const defaultName = `Variation ${i}`;
    const varName = (await prompt(`  Name for Variation ${i} [${defaultName}]: `)) || defaultName;
    const varSlug = slugify(varName);
    variations.push({ name: varName, slug: varSlug, modifications: [] });
    varSlugs.push({ name: varName, slug: varSlug });
  }

  // Create directory structure and scaffold "Custom Code" block for each variation
  const expDir = join(projectDir, 'experiences', expSlug);
  mkdirSync(expDir, { recursive: true });

  for (const { name: vName, slug: vSlug } of varSlugs) {
    const blockSlug = 'custom-code';
    const blockDir  = join(expDir, vSlug, blockSlug);
    mkdirSync(blockDir, { recursive: true });

    // VWO resource order: CSS → JS → HTML
    writeFileSync(join(blockDir, 'modification.css'), '');
    writeFileSync(join(blockDir, 'modification.js'),  '');
    writeFileSync(join(blockDir, 'modification.html'), '');

    const varIdx = variations.findIndex(v => v.slug === vSlug);
    variations[varIdx].modifications = [{
      name: 'Custom Code',
      slug: blockSlug,
      trigger: 'VWO:DOM_READY',
      resources: ['modification.css', 'modification.js', 'modification.html'],
    }];
  }

  const experience = {
    name: expName,
    slug: expSlug,
    pages: { editor: siteUrl || '', include: [], exclude: [] },
    variations,
    audiences: [],
  };

  const activeVar = varSlugs.length > 0 ? varSlugs[0].slug : 'control';

  const config = {
    $schema: 'https://nextafter.com/ss/config-schema.json',
    active: { experience: expSlug, variation: activeVar },
    experiences: [experience],
    settings: {
      cache_ttl: 3600,
      timeout_ms: 30000,
      spa: false,
      ssr: false,
      template: 'vwo',
      template_notes: TEMPLATE_EXPORT_NOTES.vwo,
    },
  };

  // Write cache entries for all variation-block combos
  for (const { slug: vSlug } of varSlugs) {
    writeCacheEntry(expSlug, vSlug);
  }

  return { config, expSlug, expName, varSlugs };
}

// ─── GTM template ─────────────────────────────────────────────────────────────

export async function runGtmWizard(projectDir, prompt, helpers) {
  const { slugify, writeCacheEntry, writeFileSync, mkdirSync, join } = helpers;

  console.log('\n  Template: GTM (Google Tag Manager)\n');

  const siteUrl    = await prompt('  Site URL (press Enter to skip):  ');
  const expName    = await prompt('  Experience / tag name:           ');
  if (!expName.trim()) {
    console.error('✖ Experience name is required.');
    process.exit(1);
  }

  const workspaceName = (await prompt('  GTM workspace name [Default Workspace]: ')) || 'Default Workspace';
  const expSlug  = slugify(expName);
  const varSlug  = slugify(workspaceName);
  const varName  = workspaceName;

  const blockSlug = 'custom-code';
  const blockDir  = join(projectDir, 'experiences', expSlug, varSlug, blockSlug);
  mkdirSync(blockDir, { recursive: true });

  writeFileSync(join(blockDir, 'modification.css'), '');
  writeFileSync(join(blockDir, 'modification.js'),  '');

  const experience = {
    name: expName,
    slug: expSlug,
    pages: { editor: siteUrl || '', include: [], exclude: [] },
    variations: [
      { name: 'Control', slug: 'control' },
      {
        name: varName,
        slug: varSlug,
        modifications: [{
          name: 'Custom Code',
          slug: blockSlug,
          trigger: 'GTM:DOM_READY',
          resources: ['modification.css', 'modification.js'],
        }],
      },
    ],
    audiences: [],
  };

  const config = {
    $schema: 'https://nextafter.com/ss/config-schema.json',
    active: { experience: expSlug, variation: varSlug },
    experiences: [experience],
    settings: {
      cache_ttl: 3600,
      timeout_ms: 30000,
      spa: false,
      ssr: false,
      template: 'gtm',
      template_notes: TEMPLATE_EXPORT_NOTES.gtm,
    },
  };

  writeCacheEntry(expSlug, varSlug);

  return { config, expSlug, expName, varSlugs: [{ name: varName, slug: varSlug }] };
}

// ─── Adobe Target template ────────────────────────────────────────────────────

export async function runAtWizard(projectDir, prompt, helpers) {
  const { slugify, writeCacheEntry, writeFileSync, mkdirSync, join } = helpers;

  console.log('\n  Template: AT (Adobe Target)\n');

  const siteUrl = await prompt('  Site URL (press Enter to skip):  ');
  const expName = await prompt('  Activity / experience name:      ');
  if (!expName.trim()) {
    console.error('✖ Experience name is required.');
    process.exit(1);
  }

  const varName = (await prompt('  Experience variation name [Experience A]: ')) || 'Experience A';
  const expSlug = slugify(expName);
  const varSlug = slugify(varName);

  const blockSlug = 'custom-code';
  const blockDir  = join(projectDir, 'experiences', expSlug, varSlug, blockSlug);
  mkdirSync(blockDir, { recursive: true });

  writeFileSync(join(blockDir, 'modification.css'), '');
  writeFileSync(join(blockDir, 'modification.js'),  '');
  writeFileSync(join(blockDir, 'modification.html'), '');

  const experience = {
    name: expName,
    slug: expSlug,
    pages: { editor: siteUrl || '', include: [], exclude: [] },
    variations: [
      { name: 'Control', slug: 'control' },
      {
        name: varName,
        slug: varSlug,
        modifications: [{
          name: 'Custom Code',
          slug: blockSlug,
          trigger: 'AT:DOM_READY',
          resources: ['modification.css', 'modification.js', 'modification.html'],
        }],
      },
    ],
    audiences: [],
  };

  const config = {
    $schema: 'https://nextafter.com/ss/config-schema.json',
    active: { experience: expSlug, variation: varSlug },
    experiences: [experience],
    settings: {
      cache_ttl: 3600,
      timeout_ms: 30000,
      spa: false,
      ssr: false,
      template: 'at',
      template_notes: TEMPLATE_EXPORT_NOTES.at,
    },
  };

  writeCacheEntry(expSlug, varSlug);

  return { config, expSlug, expName, varSlugs: [{ name: varName, slug: varSlug }] };
}

export const TEMPLATES = {
  vwo: { name: 'VWO (Visual Website Optimizer)', run: runVwoWizard },
  gtm: { name: 'GTM (Google Tag Manager)',       run: runGtmWizard },
  at:  { name: 'AT (Adobe Target)',              run: runAtWizard  },
};
