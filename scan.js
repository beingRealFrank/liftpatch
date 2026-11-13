// Liftpatch Drupal 10 -> 11 readiness scan. Runs entirely in the browser.
// Your composer files and code are read locally; the only network calls are
// to packages.drupal.org for public release metadata.
'use strict';

const PKG_URL = (name) => `https://packages.drupal.org/files/packages/8/p2/${name}.json`;

// ---------- version + constraint helpers ----------

function parseVer(s) {
  s = String(s).trim().replace(/^v/i, '').replace(/^8\.x-/, '');
  s = s.replace(/@.*$/, '');
  const pre = /-(alpha|beta|rc|dev)/i.test(s) || /^dev-/.test(s);
  const m = s.match(/^(\d+|\*|x)(?:\.(\d+|\*|x))?(?:\.(\d+|\*|x))?/i);
  if (!m) return null;
  const n = (v) => (v === undefined ? null : /^[*x]$/i.test(v) ? '*' : parseInt(v, 10));
  return { major: n(m[1]), minor: n(m[2]), patch: n(m[3]), pre };
}

const toNum = (v) => v.major * 1e6 + (v.minor || 0) * 1e3 + (v.patch || 0);

// Returns [lo, hi) as numbers for one comparator term.
function termRange(t) {
  const INF = Number.POSITIVE_INFINITY;
  t = t.trim();
  if (!t || t === '*') return [0, INF];
  let op = '';
  const om = t.match(/^(\^|~|>=|<=|>|<|!=|==|=)?\s*(.*)$/);
  op = om[1] || ''; const rest = om[2];
  const v = parseVer(rest);
  if (!v || v.major === '*') return [0, INF];
  const lo = toNum({ major: v.major, minor: v.minor === '*' ? 0 : v.minor, patch: v.patch === '*' ? 0 : v.patch });
  switch (op) {
    case '^': return [lo, (v.major + 1) * 1e6];
    case '~':
      if (v.minor === null || v.minor === '*') return [lo, (v.major + 1) * 1e6];
      if (v.patch === null) return [lo, (v.major + 1) * 1e6];
      return [lo, v.major * 1e6 + (v.minor + 1) * 1e3];
    case '>=': return [lo, INF];
    case '>': return [lo + 0.5, INF];
    case '<': return [0, lo];
    case '<=': return [0, lo + 0.5];
    case '!=': return [0, INF];
    default:
      if (v.minor === null || v.minor === '*') return [lo, (v.major + 1) * 1e6];
      if (v.patch === null || v.patch === '*') return [lo, v.major * 1e6 + (v.minor + 1) * 1e3];
      return [lo, lo + 0.5];
  }
}

// Does a Composer constraint admit any version of the given major (e.g. 11)?
function allowsMajor(constraint, major) {
  if (!constraint) return false;
  const want = [major * 1e6, (major + 1) * 1e6];
  return String(constraint).split(/\s*\|\|?\s*/).some((alt) => {
    alt = alt.trim();
    let terms;
    const hy = alt.match(/^(\S+)\s+-\s+(\S+)$/);
    if (hy) terms = ['>=' + hy[1], '<=' + hy[2]];
    else terms = alt.replace(/(>=|<=|>|<|!=|\^|~)\s+/g, '$1').split(/[\s,]+/).filter(Boolean);
    let lo = want[0], hi = want[1];
    for (const t of terms) { const [a, b] = termRange(t); lo = Math.max(lo, a); hi = Math.min(hi, b); }
    return lo < hi;
  });
}

// Composer v2 "minified" metadata: each entry only lists fields changed from the previous one.
function expandMinified(list) {
  const out = []; let cur = null;
  for (const v of list) {
    cur = cur ? { ...cur, ...v } : { ...v };
    for (const k of Object.keys(cur)) if (cur[k] === '__unset') delete cur[k];
    out.push(cur);
  }
  return out;
}

const cache = new Map();
async function fetchReleases(name) {
  if (cache.has(name)) return cache.get(name);
  const p = fetch(PKG_URL(name)).then((r) => (r.ok ? r.json() : null)).then((j) => {
    if (!j || !j.packages || !j.packages[name]) return null;
    return expandMinified(j.packages[name]);
  }).catch(() => null);
  cache.set(name, p);
  return p;
}

const isStable = (r) => !/(alpha|beta|rc|dev)/i.test(r.version) && !/^dev-/.test(r.version);
const majorOf = (ver) => { const v = parseVer(ver); return v ? v.major : null; };

// ---------- input parsing ----------

const KNOWN = {
  'drupal/ckeditor': 'CKEditor 4 is end of life. Move text formats to CKEditor 5 in core and remove this module.',
  'drupal/seven': 'Seven is retired. Switch the admin theme to Claro (in core).',
  'drupal/classy': 'Classy left core. Move your theme off it, or keep it as a contrib dependency.',
  'drupal/stable': 'Stable left core. Move your theme to stable9, or keep it as a contrib dependency.',
  'drupal/bartik': 'Bartik is retired. Olivero (in core) is the replacement.',
  'drupal/color': 'Color left core in 10 with no Drupal 11 path for most themes. Replace it with theme settings or CSS variables.',
};

const SKIP = /^drupal\/(core|core-[a-z-]+)$/;
const CORE_REMOVED_IN_11 = { action: 'Action UI', book: 'Book', forum: 'Forum', statistics: 'Statistics', tour: 'Tour', tracker: 'Activity Tracker' };

function parseComposer(text) {
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('That is not valid JSON. Paste the whole composer.lock or composer.json file.'); }
  const pkgs = [];
  let core = null, drush = null, php = null, isLock = false;
  if (Array.isArray(j.packages)) {
    isLock = true;
    for (const p of [...j.packages, ...(j['packages-dev'] || [])]) {
      if (p.name === 'drupal/core') core = p.version;
      if (p.name === 'drush/drush') drush = p.version;
      if (!p.name.startsWith('drupal/') || SKIP.test(p.name)) continue;
      if (!/^drupal-(module|theme|profile)$/.test(p.type || '')) continue;
      pkgs.push({ name: p.name, type: p.type.replace('drupal-', ''), installed: p.version, ref: p.dist && p.dist.reference });
    }
    php = j.platform && j.platform.php;
  } else if (j.require) {
    const req = { ...j.require, ...(j['require-dev'] || {}) };
    for (const [name, c] of Object.entries(req)) {
      if (name === 'drupal/core' || name === 'drupal/core-recommended') core = core || c;
      if (name === 'drush/drush') drush = c;
      if (name === 'php') php = c;
      if (!name.startsWith('drupal/') || SKIP.test(name) || name.startsWith('drupal/core-')) continue;
      pkgs.push({ name, type: 'module', installed: c, constraintOnly: true });
    }
  } else {
    throw new Error('No "packages" (composer.lock) or "require" (composer.json) section found.');
  }
  return { pkgs, core, drush, php, isLock };
}

// ---------- classification ----------

async function classify(pkg) {
  const rels = await fetchReleases(pkg.name);
  if (!rels) return { ...pkg, status: 'unknown', note: 'Not found on packages.drupal.org (private or VCS package). Treated as custom code.' };
  const project = pkg.name.replace('drupal/', '');
  const meta = rels[0] || {};
  const kw = String(meta.keywords || '');
  const unsupported = (kw.match(/(Unsupported|Obsolete|No further development|Seeking new maintainer|Minimally maintained)/i) || [])[1] || '';
  let current = null;
  if (!pkg.constraintOnly) {
    current = rels.find((r) => r.version === pkg.installed || r.version_normalized === pkg.installed ||
      (r.extra && r.extra.drupal && r.extra.drupal.version === pkg.installed) || (pkg.ref && r.dist && r.dist.reference === pkg.ref));
  }
  const coreReq = (r) => (r.require && r.require['drupal/core']) || '';
  const d11 = rels.filter((r) => allowsMajor(coreReq(r), 11));
  const d11Stable = d11.filter(isStable);
  const latest11 = d11Stable[0] || null; // releases are newest first
  const instMajor = majorOf(current ? current.version : pkg.installed);
  // Prefer a release that supports both 10 and 11 (smooth path), same major as installed.
  const bridge = d11Stable.filter((r) => allowsMajor(coreReq(r), 10));
  const sameMajorBridge = bridge.filter((r) => majorOf(r.version) === instMajor);
  const pick = sameMajorBridge[0] || bridge[0] || latest11;
  const base = { ...pkg, project, url: `https://www.drupal.org/project/${project}`, unsupported,
    installedCore: current ? coreReq(current) : '', latest11: latest11 && latest11.version, target: pick && pick.version };
  if (current && allowsMajor(coreReq(current), 11)) return { ...base, status: 'ok', note: 'Installed release already supports Drupal 11.' };
  if (pkg.constraintOnly && d11Stable.some((r) => allowsConstraint(pkg.installed, r.version))) {
    return { ...base, status: 'ok', note: `Your constraint ${pkg.installed} already allows a Drupal 11 release.` };
  }
  if (!latest11) {
    if (d11.length) return { ...base, status: 'prerelease', target: d11[0].version, note: `Only a pre-release (${d11[0].version}) supports Drupal 11.` };
    return { ...base, status: 'none', note: KNOWN[pkg.name] || 'No release supports Drupal 11. Needs a port, a community patch, or a replacement module.' };
  }
  if (instMajor !== null && majorOf(pick.version) !== instMajor) {
    return { ...base, status: 'major', note: `Drupal 11 support starts in a new major version (${pick.version}). Expect config or API changes.` };
  }
  return { ...base, status: 'update', note: `Update to ${pick.version}${allowsMajor(coreReq(pick), 10) ? ' (works on 10 and 11)' : ''}.` };
}

function allowsConstraint(constraint, version) {
  const v = parseVer(version); if (!v) return false;
  const n = toNum(v);
  return String(constraint).split(/\s*\|\|?\s*/).some((alt) => {
    const terms = alt.trim().replace(/(>=|<=|>|<|!=|\^|~)\s+/g, '$1').split(/[\s,]+/).filter(Boolean);
    return terms.every((t) => { const [a, b] = termRange(t); return n >= a && n < b; });
  });
}

// ---------- custom code scan ----------

// Heuristic pre-scan. APIs deprecated in Drupal 10.x and removed in Drupal 11.
const DEPRECATIONS = [
  [/\buser_roles\s*\(/, 'user_roles() removed in 11: use Role::loadMultiple()'],
  [/\buser_role_names\s*\(/, 'user_role_names() removed in 11'],
  [/\bwatchdog_exception\s*\(/, 'watchdog_exception() removed in 11: use Error::logException()'],
  [/\bmodule_load_include\s*\(/, 'module_load_include() removed in 11: use moduleHandler->loadInclude()'],
  [/\bformat_size\s*\(/, 'format_size() removed in 11: use ByteSizeMarkup::create()'],
  [/\bsystem_retrieve_file\s*\(/, 'system_retrieve_file() removed in 11'],
  [/\bsystem_time_zones\s*\(/, 'system_time_zones() removed in 11: use TimeZoneFormHelper'],
  [/\bfile_validate(_[a-z_]+)?\s*\(/, 'file_validate*() removed in 11: use the file.validator service'],
  [/\b_drupal_flush_css_js\s*\(/, '_drupal_flush_css_js() removed in 11: use AssetQueryString'],
  [/\bdrupal_theme_rebuild\s*\(/, 'drupal_theme_rebuild() removed in 11'],
  [/\bdrupal_get_path\s*\(|\bdrupal_get_filename\s*\(/, 'drupal_get_path()/drupal_get_filename() already removed in 10'],
  [/\bfile_create_url\s*\(|\bfile_url_transform_relative\s*\(/, 'file_create_url() already removed in 10: use file_url_generator'],
  [/FileSystemInterface::EXISTS_(RENAME|REPLACE|ERROR)/, 'FileSystemInterface::EXISTS_* deprecated: use the FileExists enum'],
  [/\bjquery\.once\b|core\/once\b.*jquery|\$\.once\(|\.once\(\s*['"]/, 'jQuery.once removed: use core/once'],
  [/\bbase theme:\s*(classy|stable|seven|bartik)\b/, 'Base theme removed from core (classy/stable/seven/bartik): needs the contrib theme or a new base'],
];

const CODE_EXT = /\.(php|module|inc|install|theme|profile|engine|twig|js|yml)$/i;
const EXCLUDE = /(^|\/)(vendor|node_modules|core|contrib|libraries|\.git|files|simpletest)(\/|$)/;

async function scanFolder(files) {
  const all = Array.from(files).map((f) => ({ f, path: f.webkitRelativePath || f.name }));
  const customRoots = all.filter((x) => /(^|\/)(modules|themes|profiles)\/custom\//.test(x.path));
  const pool = (customRoots.length ? customRoots : all).filter((x) => CODE_EXT.test(x.path) && !EXCLUDE.test(x.path.replace(/(modules|themes|profiles)\/custom\//, '')));
  const extensions = []; const hits = []; let loc = 0;
  for (const { f, path } of pool) {
    if (f.size > 2e6) continue;
    const text = await f.text();
    if (/\.info\.yml$/.test(path)) {
      const type = (text.match(/^type:\s*(\w+)/m) || [])[1] || 'module';
      const cvr = (text.match(/^core_version_requirement:\s*['"]?([^'"\n]+)/m) || [])[1] || '';
      extensions.push({ path, type, cvr, ok11: allowsMajor(cvr, 11) });
    }
    if (/\.js$/.test(path) && !/\.once|once\(/.test(text)) { loc += text.split('\n').length; continue; }
    if (!/\.yml$/.test(path) || /\.info\.yml$/.test(path)) {
      loc += text.split('\n').length;
      const lines = text.split('\n');
      DEPRECATIONS.forEach(([re, msg]) => {
        lines.forEach((ln, i) => { if (re.test(ln)) hits.push({ path, line: i + 1, msg }); });
      });
    }
  }
  return { extensions, hits, loc, scannedFiles: pool.length };
}

// ---------- pricing ----------

const PRICE = {
  base: 1490,          // core 10 -> 11, composer, up to 20 contrib with simple updates, tested patch set
  includedContrib: 20,
  perExtraContrib: 25,
  major: 120,          // contrib needing a major-version jump
  prerelease: 90,      // depend on alpha/beta/rc; we pin and test it
  none: 290,           // no D11 release: port + patch, or replace
  unknown: 190,        // private/VCS package: treated as a small custom module
  coreRemoved: 190,    // Book/Forum/Tracker/... moved to contrib
  customExt: 190,      // per custom module/theme
  perHit: 30,          // per deprecated-API hit, capped
  hitCap: 1500,
  oldCore: 240,        // core below 10.3 needs a 10.x catch-up first
  locPer1k: 60,        // custom code over 2,000 lines
};

function quote(results, env, code) {
  const lines = [];
  const add = (label, n, unit) => { if (n > 0) lines.push({ label, amount: n * unit, n, unit }); };
  lines.push({ label: 'Drupal 10 → 11 core upgrade, Composer + Drush, tested patch set', amount: PRICE.base });
  const counts = (s) => results.filter((r) => r.status === s).length;
  const simple = counts('ok') + counts('update');
  add(`Contrib updates beyond ${PRICE.includedContrib} included`, Math.max(0, simple - PRICE.includedContrib), PRICE.perExtraContrib);
  add('Contrib needing a major-version jump', counts('major'), PRICE.major);
  add('Contrib with only a pre-release for Drupal 11', counts('prerelease'), PRICE.prerelease);
  add('Contrib with no Drupal 11 release (port or replace)', counts('none'), PRICE.none);
  add('Private / non-drupal.org packages', counts('unknown'), PRICE.unknown);
  add('Core modules removed in Drupal 11 (move to contrib)', env.coreRemovedUsed.length, PRICE.coreRemoved);
  if (env.oldCore) lines.push({ label: 'Core below 10.3: catch-up to 10.3+ first', amount: PRICE.oldCore });
  if (code) {
    add('Custom modules / themes', code.extensions.length, PRICE.customExt);
    if (code.hits.length) lines.push({ label: `Deprecated-API fixes (${code.hits.length} found)`, amount: Math.min(PRICE.hitCap, code.hits.length * PRICE.perHit) });
    const extraK = Math.max(0, Math.ceil((code.loc - 2000) / 1000));
    add('Custom code size (per 1,000 lines over 2,000)', extraK, PRICE.locPer1k);
  }
  const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) / 10) * 10;
  return { lines, total, agency: Math.round(total * 0.7 / 10) * 10, custom: total > 9000 };
}

if (typeof module !== 'undefined') module.exports = { allowsMajor, allowsConstraint, expandMinified, parseComposer, classify, quote, termRange, PRICE, CORE_REMOVED_IN_11 };
