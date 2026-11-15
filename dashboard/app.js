const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const DATA = window.RADAR;
function renderStats() {
    const s = DATA.counts;
    document.getElementById('stats').textContent = s.total + ' protocols, ' + s.watchlist + ' watchlist, ' + DATA.rows.length + ' board rows, ' + s.early + ' early, ' + s.live + ' live, ' + s.excluded + ' excluded.';
}

const state = { q: '', category: 'all', chain: 'all', watchlistOnly: false, sort: 'rank', tab: 'board', dir: 1 };


const compactFmt = (n) => {
    if (n === null || n === undefined) return 'n/a';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(2) + 'K';
    return '$' + Math.round(n);
};
const fmtPct = (n) => n !== null ? (n > 0 ? '+' : '') + n.toFixed(2) + '%' : 'n/a';

// Short chain cell: first chain plus a count, so the table stays narrow.
const shortChains = (chains) => {
    if (!chains || chains.length === 0) return 'n/a';
    return chains.length === 1 ? chains[0] : chains[0] + ' +' + (chains.length - 1);
};

const convBadgeClass = (v) => v >= 65 ? 'conv-high' : v >= 50 ? 'conv-good' : v >= 40 ? 'conv-mid' : 'conv-low';

const fmtMedian = (median, peers) => median === null ? 'n/a' : median.toFixed(4) + ' · ' + peers + (peers === 1 ? ' peer' : ' peers');

function populateSelects() {
    const categories = [...new Set(DATA.rows.map(r => r.category).filter(c => c))].sort();
    const chains = [...new Set(DATA.rows.flatMap(r => r.chains))].sort();
    const catSelect = document.getElementById('category');
    categories.forEach(c => catSelect.innerHTML += `<option value="${esc(c)}">${esc(c)}</option>`);
    const chainSelect = document.getElementById('chain');
    chains.forEach(c => chainSelect.innerHTML += `<option value="${esc(c)}">${esc(c)}</option>`);
}

// Page-side recomputation: the page refits nothing from stored values — it
// recomputes every row's Conviction and every category median from
// DATA.liveAll with the model.js functions, then reports whether the page's
// numbers match the stored ones. Runs once, at load.
let boardLogMin = null;
let boardLogMax = null;
let pageConvictionMismatches = 0;
let pageMedianMismatches = 0;
let pageMedianChecked = 0;
let pageConvictionComputed = false;

function computePageConviction() {
    if (pageConvictionComputed) return;
    pageConvictionComputed = true;
    if (!Array.isArray(DATA.rows) || DATA.rows.length === 0) return;
    if (!Array.isArray(DATA.liveAll) || DATA.liveAll.length === 0) return;
    const logs = DATA.rows.map(r => Math.log10(r.tvl_usd)).filter(Number.isFinite);
    boardLogMin = Math.min.apply(null, logs);
    boardLogMax = Math.max.apply(null, logs);
    const medianCache = {};
    const medianFor = (category) => {
        if (!(category in medianCache)) {
            medianCache[category] = window.TokenRadarModel.categoryMedian(DATA.liveAll, category);
        }
        return medianCache[category];
    };
    DATA.rows.forEach(row => {
        const med = medianFor(row.category);
        const legs = window.TokenRadarModel.convictionLegs(
            row, boardLogMin, boardLogMax,
            med ? med.median : null, med ? med.peers : 0
        );
        row._pageLegs = legs;
        row._pageMedian = med;
        if (legs.total !== row.conviction ||
            legs.scale !== row.conviction_legs.scale ||
            legs.momentum !== row.conviction_legs.momentum ||
            legs.maturity !== row.conviction_legs.maturity ||
            legs.peers !== row.conviction_legs.peers ||
            legs.agreement !== row.conviction_legs.agreement) {
            pageConvictionMismatches += 1;
        }
        if (row.cat_median !== null) {
            pageMedianChecked += 1;
            if (!med || med.median !== row.cat_median || med.peers !== row.cat_peers) {
                pageMedianMismatches += 1;
            }
        } else if (med !== null) {
            pageMedianMismatches += 1;
        }
    });
    const line = document.getElementById('conviction-check');
    if (line) {
        line.textContent = 'Conviction check (computed live on this page from the 128 live tokens): page recomputation matches the stored Conviction for ' +
            (DATA.rows.length - pageConvictionMismatches) + '/' + DATA.rows.length + ' rows; page category medians match the stored medians for ' +
            (pageMedianChecked - pageMedianMismatches) + '/' + pageMedianChecked + ' rows with a median.';
    }
}

function renderTable() {
    const tbody = document.getElementById('table-body');
    const tableHead = document.getElementById('table-head');
    const note = document.getElementById('live-note') || document.createElement('p');
    note.id = 'live-note';
    note.style.display = 'none';
    if (!document.getElementById('live-note')) document.getElementById('tabs').after(note);

    if (state.tab === 'categories') {
        tableHead.innerHTML = `
            <th>Category</th>
            <th>Board rows</th>
            <th>Live peers</th>
            <th>Median multiple</th>
        `;
        tbody.innerHTML = DATA.model.categories.map(c => `
            <tr>
                <td>${esc(c.category)}</td>
                <td>${esc(c.board_rows)}</td>
                <td>${esc(c.live_peers)}</td>
                <td>${c.median_multiple === null ? 'n/a — no live peers' : c.median_multiple.toFixed(4)}</td>
            </tr>
        `).join('');
        note.style.display = 'block';
        note.innerHTML = 'Medians are context, not a multiplier: no category term enters the implied value. A median from 1 peer is that peer alone.';
        return;
    }

    let rows = state.tab === 'board' ? [...DATA.rows] : [...DATA.live];
    if (state.tab === 'board') {
        if (state.q) rows = rows.filter(r => r.name.toLowerCase().includes(state.q.toLowerCase()) || r.slug.toLowerCase().includes(state.q.toLowerCase()));
        if (state.category !== 'all') rows = rows.filter(r => r.category === state.category);
        if (state.chain !== 'all') rows = rows.filter(r => r.chains.includes(state.chain));
        if (state.watchlistOnly) rows = rows.filter(r => r.watchlist);

        const sortMap = { rank: 'rank', implied: 'implied_value_usd', tvl: 'tvl_usd', '7d': 'change_7d', age: 'age_days', name: 'name', category: 'category', chain: 'chains', conviction: 'conviction', cat_median: 'cat_median' };
        const key = sortMap[state.sort];
        const dir = state.dir || 1;
        rows.sort((a, b) => {
          if (key === 'name') return dir * a.name.localeCompare(b.name);
          let valA = a[key], valB = b[key];
          if (valA === null || valA === undefined) return 1;
          if (valB === null || valB === undefined) return -1;
          if (key === 'rank') return dir * (valA - valB);
          return dir * (valB - valA);
        });
    } else {
        rows.sort((a, b) => (b.mcap_usd || 0) - (a.mcap_usd || 0));
    }

    if (state.tab === 'board') {
        tableHead.innerHTML = `
            <th data-sort="rank">Rank</th>
            <th data-sort="name">Protocol</th>
            <th data-sort="category">Category</th>
            <th data-sort="chain">Chains</th>
            <th data-sort="tvl">TVL</th>
            <th data-sort="7d">7d %</th>
            <th data-sort="age">Age (days)</th>
            <th data-sort="conviction">Conviction</th>
            <th data-sort="cat_median">Cat. median</th>
            <th data-sort="implied">Implied value</th>
        `;
        tbody.innerHTML = rows.map(r => `
            <tr class="${r.watchlist ? 'watchlist-row' : ''}" onclick="openDialog('${r.slug}')">
                <td>${esc(r.rank)}</td>
                <td>${esc(r.name)} ${r.watchlist ? '★' : ''}</td>
                <td>${esc(r.category || 'N/A')}</td>
                <td>${esc(shortChains(r.chains))}</td>
                <td>${compactFmt(r.tvl_usd)}</td>
                <td>${fmtPct(r.change_7d)}</td>
                <td>${esc(r.age_days ?? 'N/A')}</td>
                <td><span class="conv-badge ${convBadgeClass(r.conviction)}" title="scale ${r.conviction_legs.scale}, momentum ${r.conviction_legs.momentum}, maturity ${r.conviction_legs.maturity}, peers ${r.conviction_legs.peers}, agreement ${r.conviction_legs.agreement}">${esc(r.conviction)}</span></td>
                <td>${fmtMedian(r.cat_median, r.cat_peers)}</td>
                <td>${compactFmt(r.implied_value_usd)}</td>
            </tr>
        `).join('');
    } else {
        tableHead.innerHTML = `<th>Protocol</th><th>Category</th><th>Chains</th><th>TVL</th><th>Market cap</th>`;
        tbody.innerHTML = rows.map(r => `
            <tr>
                <td>${esc(r.name)}</td>
                <td>${esc(r.category || 'N/A')}</td>
                <td>${esc(shortChains(r.chains))}</td>
                <td>${compactFmt(r.tvl_usd)}</td>
                <td>${compactFmt(r.mcap_usd)}</td>
            </tr>
        `).join('');
        note.style.display = 'block';
        note.innerHTML = 'already trades — market cap is a fact, not a model';
    }
}

let pageBands = null;

function bands() {
    if (!pageBands) pageBands = window.TokenRadarModel.convictionBands(DATA.rows);
    return pageBands;
}

// One-line live summary under the backtest bar: the row count in each
// Conviction band, computed from DATA.rows on this page, never typed in.
function renderBandsLine() {
    const el = document.getElementById('bands-line');
    if (!el) return;
    el.textContent = 'Conviction bands (live): ' + bands().map(b => b.count + ' rows ' + b.label).join(' · ') + '.';
}

// Small table for the model panel: band, rows, median implied value and
// the band's top protocol (name plus its implied value, looked up by slug).
function bandsTableHtml() {
    const rows = bands().map(b => {
        const top = b.topSlug ? DATA.rows.find(r => r.slug === b.topSlug) : null;
        return `<tr>
            <td><span class="conv-badge ${convBadgeClass(b.min)}">${esc(b.label)}</span></td>
            <td>${b.count}</td>
            <td>${compactFmt(b.medianImplied)}</td>
            <td>${top ? esc(top.name) + ' (' + compactFmt(top.implied_value_usd) + ')' : 'n/a'}</td>
        </tr>`;
    }).join('');
    return `<p>Conviction bands (computed live on this page from the board rows):</p>
        <table class="bands-table">
            <thead><tr><th>Band</th><th>Rows</th><th>Median implied value</th><th>Top protocol in band</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
}

let pageCurve = null;
let pageBacktest = null;
let pageMetricsComputed = false;

function renderModelPanel() {
    if (!pageMetricsComputed) {
        pageMetricsComputed = true;
        if (Array.isArray(DATA.liveAll) && DATA.liveAll.length > 0) {
            pageCurve = window.TokenRadarModel.fitSizeCurve(DATA.liveAll);
            pageBacktest = window.TokenRadarModel.backtest(DATA.liveAll);
        }
    }

    const curve = DATA.model.curve;
    const liveCurveLines = pageCurve
        ? `
        <p>Page-fitted curve (fitted live on this page from ${pageCurve.n} live tokens): intercept ${pageCurve.intercept.toFixed(4)}, slope ${pageCurve.slope.toFixed(4)}, n ${pageCurve.n}.</p>
        <p>Page fit matches the board's stored curve: ${pageCurve.intercept === curve.intercept && pageCurve.slope === curve.slope ? 'yes' : 'no — see the two curves above'}</p>
        ${pageBacktest.curve === null
            ? '<p>Backtest: not enough live tokens to compute.</p>'
            : `<p>Backtest (5-fold CV, ${pageBacktest.n} live tokens, computed live on this page): median |log10 error| ${pageBacktest.curve.toFixed(2)} = ${Math.pow(10, pageBacktest.curve).toFixed(1)}x, vs a flat median multiple ${pageBacktest.flat.toFixed(2)} = ${Math.pow(10, pageBacktest.flat).toFixed(1)}x.</p>`}
        `
        : '';
    const examples = [
        ['$10M', 10_000_000],
        ['$100M', 100_000_000],
        ['$1B', 1_000_000_000],
        ['$10B', 10_000_000_000],
    ].map(([label, tvl]) =>
        `<li>${label} TVL: ${window.TokenRadarModel.sizeMultiple(tvl, curve).toFixed(4)}</li>`
    ).join('');
    const convictionLegs = DATA.model.conviction.legs.map(leg =>
        `<li>${esc(leg.name)} (${leg.weight}): ${esc(leg.description)}</li>`
    ).join('');

    document.getElementById('model-panel').innerHTML = `
        <p>Formula: ${esc(DATA.model.formula)}</p>
        <p>Fitted curve: intercept ${curve.intercept.toFixed(4)}, slope ${curve.slope.toFixed(4)}, n ${curve.n}.</p>
        ${liveCurveLines}
        <p>Example size multiples:</p>
        <ul>${examples}</ul>
        <p>Conviction: ${esc(DATA.model.conviction.formula)}. It scores the evidence behind a row's implied value and never changes the value or the rank.</p>
        <ul>${convictionLegs}</ul>
        ${bandsTableHtml()}
        <p>144 pre-token protocols are excluded: wrapped, bridged, staked and exchange products are not protocols awaiting a token launch.</p>
        <p>Snapshot frozen 2026-11-14. Multiples are comparables from the snapshot's own live tokens, not predictions; no protocol name is hardcoded into the model.</p>
    `;
}

// One or two sentences, built only from this row's own fields: its TVL tier,
// 7-day change, age, Conviction total and strongest leg. No outside facts.
function whyThisRank(row) {
    const tier = row.tvl_usd >= 1_000_000_000 ? 'large' : row.tvl_usd >= 100_000_000 ? 'mid-size' : 'smaller';
    const growth = row.change_7d === null
        ? '7-day TVL change unreported'
        : '7-day TVL change ' + fmtPct(row.change_7d);
    const age = row.age_days === null ? 'age unreported' : row.age_days + ' days of history';
    const legs = [
        ['scale', row.conviction_legs.scale, 25],
        ['momentum', row.conviction_legs.momentum, 20],
        ['maturity', row.conviction_legs.maturity, 20],
        ['peers', row.conviction_legs.peers, 20],
        ['agreement', row.conviction_legs.agreement, 15],
    ];
    let strongest = legs[0];
    legs.forEach(leg => { if (leg[1] > strongest[1]) strongest = leg; });
    return 'Rank ' + row.rank + ' by implied value: a ' + tier + ' TVL of ' + compactFmt(row.tvl_usd) + ', ' +
        growth + ', ' + age + '. Conviction ' + row.conviction + '/100, strongest leg ' +
        strongest[0] + ' (' + strongest[1] + '/' + strongest[2] + ').';
}

function openDialog(slug) {
    const row = DATA.rows.find(r => r.slug === slug);
    if (!row) return;
    const dialog = document.getElementById('detail-dialog');
    const pageCurveMatchesStored = pageCurve &&
        pageCurve.intercept === DATA.model.curve.intercept &&
        pageCurve.slope === DATA.model.curve.slope;
    const recomputeCurve = pageCurveMatchesStored ? pageCurve : DATA.model.curve;
    const recomputed = window.TokenRadarModel.impliedValue(row, recomputeCurve);
    const pageLegs = row._pageLegs || null;
    const pageMed = row._pageMedian || null;
    const legsAgree = pageLegs &&
        pageLegs.total === row.conviction &&
        pageLegs.scale === row.conviction_legs.scale &&
        pageLegs.momentum === row.conviction_legs.momentum &&
        pageLegs.maturity === row.conviction_legs.maturity &&
        pageLegs.peers === row.conviction_legs.peers &&
        pageLegs.agreement === row.conviction_legs.agreement;
    const medianAgree = row.cat_median === null
        ? pageMed === null
        : pageMed !== null && pageMed.median === row.cat_median && pageMed.peers === row.cat_peers;
    const legRows = [
        ['scale', 25, row.conviction_legs.scale],
        ['momentum', 20, row.conviction_legs.momentum],
        ['maturity', 20, row.conviction_legs.maturity],
        ['peers', 20, row.conviction_legs.peers],
        ['agreement', 15, row.conviction_legs.agreement],
    ].map(([name, weight, stored]) => {
        const recomp = pageLegs ? pageLegs[name] : null;
        return `<li>${name}: ${stored} stored / ${recomp === null ? 'n/a' : recomp} recomputed (of ${weight})</li>`;
    }).join('');
    document.getElementById('dialog-content').innerHTML = `
        <h2>${esc(row.name)}</h2>
        <p>TVL: ${compactFmt(row.tvl_usd)}</p>
        <p>sizeMultiple: ${row.size_multiple.toFixed(4)} (size-fitted multiple from TVL)</p>
        <p>growthMult: ${row.growth_mult.toFixed(4)} (change_7d ${row.change_7d === null ? 'n/a' : row.change_7d + '%'})</p>
        <p>maturityMult: ${row.maturity_mult.toFixed(4)} (age ${row.age_days === null ? 'n/a' : row.age_days + ' days'})</p>
        <p>Age: ${row.age_days === null ? 'n/a' : row.age_days + ' days'}</p>
        <p>Implied value (stored): ${compactFmt(row.implied_value_usd)}</p>
        <p>Implied value (recomputed): ${compactFmt(recomputed)}</p>
        <p>Stored and recomputed agree: ${recomputed === row.implied_value_usd ? 'yes — the page and the board use the same model' : 'no — see the two values above'}</p>
        <p>Recomputed with: ${pageCurveMatchesStored ? 'the page-fitted curve' : "the board's stored curve"}</p>
        <h3>Conviction breakdown</h3>
        <ul>${legRows}</ul>
        <p>Conviction (stored): ${row.conviction}/100; Conviction (recomputed on this page): ${pageLegs ? pageLegs.total + '/100' : 'n/a'}</p>
        <p>Stored and recomputed Conviction agree: ${legsAgree ? 'yes' : 'no — see the legs above'}</p>
        <h3>Category median</h3>
        <p>Category median (stored): ${fmtMedian(row.cat_median, row.cat_peers)}</p>
        <p>Category median (recomputed on this page): ${pageMed ? fmtMedian(pageMed.median, pageMed.peers) : 'n/a — no live peers in this category'}</p>
        <p>Stored and recomputed category median agree: ${medianAgree ? 'yes' : 'no — see the two values above'}</p>
        <p><strong>Why this rank:</strong> ${esc(whyThisRank(row))}</p>
        <h3>Farm Steps</h3>
        <ul>${row.farm_steps.map(step => `<li>${esc(step)}</li>`).join('')}</ul>
        <p><em>Records no token</em></p>
    `;
    if (!dialog.open) dialog.showModal();
    history.replaceState(null, '', '#p=' + slug);
}

document.getElementById('q').addEventListener('input', e => { state.q = e.target.value; renderTable(); });
document.getElementById('category').addEventListener('change', e => { state.category = e.target.value; renderTable(); history.replaceState(null, '', '#category=' + state.category); });
document.getElementById('chain').addEventListener('change', e => { state.chain = e.target.value; renderTable(); history.replaceState(null, '', '#chain=' + state.chain); });
document.getElementById('watchlist-only').addEventListener('change', e => { state.watchlistOnly = e.target.checked; renderTable(); });
document.getElementById('sort').addEventListener('change', e => { state.sort = e.target.value; renderTable(); });
document.getElementById('board-table').querySelector('thead').addEventListener('click', (e) => { const th = e.target.closest('th[data-sort]'); if (!th || state.tab !== 'board') return; const k = th.getAttribute('data-sort'); if (state.sort === k) { state.dir = (state.dir === 1 ? -1 : 1); } else { state.sort = k; state.dir = 1; } renderTable(); });

function setActiveTab(id) {
    ['tab-board', 'tab-live', 'tab-categories'].forEach(t => {
        const b = document.getElementById(t);
        if (b) b.classList.toggle('active', t === id);
    });
}
document.getElementById('tab-board').addEventListener('click', () => { state.tab = 'board'; setActiveTab('tab-board'); renderTable(); });
document.getElementById('tab-live').addEventListener('click', () => { state.tab = 'live'; setActiveTab('tab-live'); renderTable(); });
document.getElementById('tab-categories').addEventListener('click', () => { state.tab = 'categories'; setActiveTab('tab-categories'); renderTable(); });
document.getElementById('close-dialog').addEventListener('click', () => document.getElementById('detail-dialog').close());

function handleHash() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    if (params.has('p')) openDialog(params.get('p'));
    if (params.has('category')) {
        state.category = params.get('category');
        document.getElementById('category').value = state.category;
    }
    if (params.has('q')) {
        state.q = params.get('q');
        document.getElementById('q').value = state.q;
    }
    if (params.has('chain')) {
        state.chain = params.get('chain');
        document.getElementById('chain').value = state.chain;
    }
    renderTable();
}

window.addEventListener('hashchange', handleHash);
renderStats();
computePageConviction();
renderBandsLine();
renderModelPanel();
populateSelects();
handleHash();
