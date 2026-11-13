'use strict';
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + n.toLocaleString('en-US');
  const CFG = window.LIFTPATCH || {};

  // deadline countdown
  const days = Math.ceil((Date.UTC(2026, 11, 9) - Date.now()) / 864e5);
  if (days > 0) $('#deadline').innerHTML = `Drupal 10 security support ends <strong>December 9, 2026</strong>, ${days} day${days === 1 ? '' : 's'} from now.`;
  else $('#deadline').innerHTML = 'Drupal 10 reached end of life on <strong>December 9, 2026</strong>. It no longer gets security releases.';

  // removed core modules checkboxes
  const cr = $('#coreRemoved');
  Object.entries(CORE_REMOVED_IN_11).forEach(([k, v]) => {
    const l = document.createElement('label'); l.innerHTML = `<input type="checkbox" value="${k}"> ${esc(v)}`; cr.appendChild(l);
  });

  // price table
  const P = PRICE;
  const rows = [
    ['Core 10 → 11 with Composer, Drush and up to ' + P.includedContrib + ' contrib updates, tested patch set', money(P.base)],
    ['Each further contrib update', money(P.perExtraContrib)],
    ['Contrib needing a major-version jump', money(P.major)],
    ['Contrib with only a pre-release for 11', money(P.prerelease)],
    ['Contrib with no Drupal 11 release (port, patch or replace)', money(P.none)],
    ['Core module leaving core (Book, Forum, Tracker…)', money(P.coreRemoved)],
    ['Custom module or theme', money(P.customExt)],
    ['Each removed-API fix in custom code (capped at ' + money(P.hitCap) + ')', money(P.perHit)],
    ['Custom code, per 1,000 lines over 2,000', money(P.locPer1k)],
    ['Catch-up from core below 10.3', money(P.oldCore)],
  ];
  $('#pricetable').innerHTML = rows.map(([a, b]) => `<tr><td>${esc(a)}</td><td class="num">${b}</td></tr>`).join('');

  // inputs
  let codeScan = null;
  $('#sample').addEventListener('click', async () => { $('#composer').value = await (await fetch('samples/composer.lock')).text(); $('#run').click(); });
  $('#lockfile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) $('#composer').value = await f.text(); });
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) $('#composer').value = await f.text(); });
  $('#folder').addEventListener('change', async (e) => {
    $('#folderinfo').textContent = 'Reading files locally…';
    codeScan = await scanFolder(e.target.files);
    const all = Array.from(e.target.files);
    const ext = all.find((f) => /core\.extension\.yml$/.test(f.webkitRelativePath));
    if (ext) {
      const t = await ext.text();
      Object.keys(CORE_REMOVED_IN_11).forEach((k) => { if (new RegExp('^\\s+' + k + ':\\s*-?\\d', 'm').test(t)) cr.querySelector(`input[value=${k}]`).checked = true; });
    }
    $('#folderinfo').textContent = `Read ${codeScan.scannedFiles} files locally: ${codeScan.extensions.length} custom modules/themes, ${codeScan.loc.toLocaleString()} lines, ${codeScan.hits.length} removed-API uses.` + (ext ? ' Found core.extension.yml and ticked the core modules you use.' : '');
  });

  const LABEL = { ok: 'Ready', update: 'Update', major: 'Major update', prerelease: 'Pre-release only', none: 'Blocker', unknown: 'Not on drupal.org' };
  let last = null;

  $('#run').addEventListener('click', async () => {
    $('#err').textContent = '';
    let parsed;
    try { parsed = parseComposer($('#composer').value); } catch (e) { $('#err').textContent = e.message; return; }
    if (!parsed.pkgs.length && !parsed.core) { $('#err').textContent = 'No Drupal packages found in that file.'; return; }
    $('#run').disabled = true; $('#run').textContent = `Checking ${parsed.pkgs.length} projects…`;
    const results = [];
    const queue = parsed.pkgs.slice();
    await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) { const p = queue.shift(); results.push(await classify(p)); } }));
    const order = { none: 0, prerelease: 1, major: 2, unknown: 3, update: 4, ok: 5 };
    results.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
    const coreRemovedUsed = Array.from(cr.querySelectorAll('input:checked')).map((i) => i.value);
    const coreV = parsed.core ? String(parsed.core) : '';
    const cv = coreV.match(/(\d+)\.(\d+)/);
    const oldCore = parsed.isLock && cv && (+cv[1] < 10 || (+cv[1] === 10 && +cv[2] < 3));
    const env = { coreRemovedUsed, oldCore, core: coreV, drush: parsed.drush, php: parsed.php, isLock: parsed.isLock };
    const q = quote(results, env, codeScan);
    last = { results, env, q, code: codeScan };
    render(last);
    $('#run').disabled = false; $('#run').textContent = 'Scan and quote';
  });

  function render({ results, env, q, code }) {
    $('#results').hidden = false;
    const c = (s) => results.filter((r) => r.status === s).length;
    $('#summary').innerHTML = [['ok', 'ready'], ['update', 'need an update'], ['major', 'need a major update'], ['prerelease', 'pre-release only'], ['none', 'blockers'], ['unknown', 'not on drupal.org']]
      .map(([k, l]) => `<div class="pill ${k}"><b>${c(k)}</b> ${l}</div>`).join('');
    const notes = [];
    if (env.core) notes.push(`Drupal core: <b>${esc(env.core)}</b>${env.oldCore ? ' (below 10.3: catch up to 10.3+ first)' : ''}.`);
    if (env.drush) notes.push(`Drush: <b>${esc(env.drush)}</b>${/^(\^|~)?1[0-2]\b|^[0-9]\./.test(env.drush) ? ' (Drupal 11 needs Drush 13)' : ''}.`);
    notes.push('Drupal 11 needs PHP 8.3 or newer on your server.');
    if (!env.isLock) notes.push('You scanned composer.json, so these statuses come from your version constraints. Scan composer.lock for exact results.');
    if (env.coreRemovedUsed.length) notes.push('Leaving core: ' + env.coreRemovedUsed.map((k) => CORE_REMOVED_IN_11[k]).join(', ') + '.');
    $('#envnotes').innerHTML = notes.map((n) => `<p class="hint">${n}</p>`).join('');
    $('#table tbody').innerHTML = results.map((r) => `<tr class="${r.status}"><td>${r.url ? `<a href="${esc(r.url)}" rel="noopener" target="_blank">${esc(r.project)}</a>` : esc(r.name)}</td><td>${esc(r.installed)}</td><td><span class="tag ${r.status}">${LABEL[r.status]}</span></td><td>${esc(r.status === 'ok' ? '' : r.target || '')}</td><td>${esc(r.note)}${r.unsupported ? ' <em>Maintenance: ' + esc(r.unsupported) + '</em>' : ''}</td></tr>`).join('');
    if (code) {
      const bad = code.extensions.filter((e) => !e.ok11);
      $('#codeout').innerHTML = `<h3>Custom code</h3><p class="hint">${code.extensions.length} custom extensions, ${code.loc.toLocaleString()} lines. ${bad.length} still need <code>core_version_requirement</code> to include ^11.</p>` +
        (code.hits.length ? '<ul class="hits">' + code.hits.slice(0, 60).map((h) => `<li><code>${esc(h.path)}:${h.line}</code> ${esc(h.msg)}</li>`).join('') + (code.hits.length > 60 ? `<li>…and ${code.hits.length - 60} more</li>` : '') + '</ul>' : '<p class="hint">No uses of APIs removed in Drupal 11 found by the quick scan. We run the full PHPStan deprecation check during delivery.</p>');
    } else $('#codeout').innerHTML = '<p class="hint">Custom code not scanned. Each custom module adds about ' + money(PRICE.customExt) + '. Choose your folder above for an exact figure.</p>';
    $('#quote tbody').innerHTML = q.lines.map((l) => `<tr><td>${esc(l.label)}${l.n ? ` <span class="muted">(${l.n} × ${money(l.unit)})</span>` : ''}</td><td class="num">${money(l.amount)}</td></tr>`).join('') +
      `<tr class="total"><td>Fixed price</td><td class="num">${money(q.total)}</td></tr><tr class="muted"><td>Agency price (30% off)</td><td class="num">${money(q.agency)}</td></tr>`;
    const ref = qref(results, q); $('#qref').textContent = ref;
    const cta = $('#cta');
    if (CFG.ordersOpen && CFG.email) {
      const subj = encodeURIComponent(`Drupal 11 upgrade order ${ref}`);
      const body = encodeURIComponent(`Quote ${ref}: ${money(q.total)}\nSite URL:\nRepository host (GitHub/GitLab/Bitbucket/zip):\nPHP version on the server:\nAgency? (yes/no):\n\n--- report ---\n` + markdown().slice(0, 1500));
      cta.innerHTML = `<a class="primary big" href="mailto:${esc(CFG.email)}?subject=${subj}&body=${body}">Order this upgrade for ${money(q.total)}</a><p class="hint">This opens an email with your quote reference. You get a payment link and repository-access steps back within one business day. Delivery is usually within 5 business days of repository access.</p>`;
    } else {
      cta.innerHTML = '<p class="hint">Ordering opens shortly. Download your report now; your quote reference stays valid until December 31, 2026.</p>';
    }
  }

  function qref(results, q) {
    const s = results.map((r) => r.name + '@' + r.installed).join(',') + '|' + q.total;
    let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return 'LP-' + (h >>> 0).toString(36).toUpperCase();
  }

  function markdown() {
    if (!last) return '';
    const { results, env, q, code } = last;
    let md = `# Drupal 11 readiness report (${$('#qref').textContent})\n\nGenerated ${new Date().toISOString().slice(0, 10)} by https://beingrealfrank.github.io/liftpatch/\n\nCore: ${env.core || 'unknown'}${env.oldCore ? ' (catch up to 10.3+ first)' : ''}. Drupal 11 needs PHP 8.3+, Drush 13.\n\n| Project | Installed | Status | Move to | Notes |\n|---|---|---|---|---|\n`;
    md += results.map((r) => `| ${r.project || r.name} | ${r.installed} | ${LABEL[r.status]} | ${r.status === 'ok' ? '' : r.target || ''} | ${r.note} |`).join('\n');
    if (code) md += `\n\n## Custom code\n${code.extensions.length} extensions, ${code.loc} lines, ${code.hits.length} removed-API uses.\n` + code.hits.map((h) => `- ${h.path}:${h.line} ${h.msg}`).join('\n');
    md += '\n\n## Fixed quote\n' + q.lines.map((l) => `- ${l.label}: $${l.amount}`).join('\n') + `\n- **Total: $${q.total}** (agency: $${q.agency})\n`;
    return md;
  }
  $('#copy').addEventListener('click', async () => { await navigator.clipboard.writeText(markdown()); $('#copy').textContent = 'Copied'; setTimeout(() => ($('#copy').textContent = 'Copy report as Markdown'), 1500); });
  $('#download').addEventListener('click', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([markdown()], { type: 'text/markdown' })); a.download = `drupal11-report-${$('#qref').textContent}.md`; a.click(); });
})();
