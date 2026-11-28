import { fetchCached, mobilePlatform, appLink, ageDays, dayString } from './reader.js?v=27';
import { getTrend, shortDelta, deltaClass, formatPct, dayLabel, renderRankBadges, renderTrendPanel, windowMetric } from './daily.js?v=27';

const nf = new Intl.NumberFormat('zh-CN');
const wanNf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const shardCache = new Map();

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtReaders = (n) => (!Number.isFinite(n) ? '暂无' : n >= 10000 ? `${wanNf.format(n / 10000)} 万` : nf.format(n));
const fmtWords = (n) => (!Number.isFinite(n) ? '' : n >= 10000 ? `${wanNf.format(n / 10000)}万字` : `${nf.format(n)}字`);
const fmtScoreCnt = (n) => (!Number.isFinite(n) || n <= 0 ? '' : `${n >= 10000 ? `${wanNf.format(n / 10000)}万` : nf.format(n)}人评价`);

export function bookBucketId(id) {
  const s = String(id ?? '').trim();
  if (/^\d+$/.test(s)) {
    const tail = s.length >= 2 ? s.slice(-2) : s;
    return String(Number(tail) % 100).padStart(2, '0');
  }
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100;
  return String(h).padStart(2, '0');
}

export async function loadBookShard(id, ver = '', opts = {}) {
  const bucket = bookBucketId(id);
  const cacheKey = `${bucket}|${ver}`;
  if (!opts.forceNetwork && shardCache.has(cacheKey)) {
    return shardCache.get(cacheKey);
  }
  const path = `./data/books/b${bucket}.json.gz`;
  const res = await fetchCached(path, {
    gz: true,
    timeoutMs: opts.timeoutMs ?? 15000,
    stallMs: opts.stallMs ?? 15000,
    maxTotalMs: opts.maxTotalMs ?? 40000,
    retries: opts.retries ?? 2,
    ver,
    forceNetwork: Boolean(opts.forceNetwork),
  });
  shardCache.set(cacheKey, res.data);
  return res.data;
}

export function resolveReadAction(book) {
  const bid = String(book?.id || '').trim();
  const webUrl = `https://fanqienovel.com/page/${encodeURIComponent(bid)}`;
  const plat = mobilePlatform();
  const deepUrl = plat ? appLink(bid, plat) : '';
  if (deepUrl) {
    return {
      primary: { kind: 'app', label: '去番茄 App 读 ↗', href: deepUrl },
      secondary: { kind: 'web', label: '番茄网页版 ↗', href: webUrl },
    };
  }
  return {
    primary: { kind: 'web', label: '前往番茄网页版 ↗', href: webUrl },
    secondary: null,
  };
}

function fmtAge(start, at) {
  const d = ageDays(start, at);
  if (d === null) return '';
  if (d <= 100) return `开书 ${d} 天`;
  const ann = new Date(`${start}T00:00:00Z`);
  ann.setUTCFullYear(ann.getUTCFullYear() + 1);
  if (Date.parse(at) < ann.getTime()) return `开书 ${Math.min(11, Math.floor(d / 30))} 个月`;
  return `开书 ${Number((d / 365.2425).toFixed(1))} 年`;
}

function fmtLastUpdate(ts) {
  if (!Number.isFinite(ts) || ts <= 946684800) return '';
  const d = new Date(ts * 1000);
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diffDays <= 0) return '今日更新';
  if (diffDays === 1) return '昨日更新';
  if (diffDays <= 30) return `${diffDays} 天前更新`;
  return `${d.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' })} 更新`;
}

function fineTagsOf(book) {
  const primSet = new Set(Array.isArray(book?.primary) ? book.primary : []);
  const all = [
    ...(Array.isArray(book?.tags) ? book.tags : []),
    ...Object.values(book?.officialTags || {}).flat(),
  ];
  const out = [];
  const seen = new Set();
  for (const t of all) {
    if (typeof t !== 'string') continue;
    const s = t.trim();
    if (!s || s === '全部分类' || primSet.has(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function channelMatches(targetCh, candCh) {
  if (!targetCh || targetCh === '共用') return true;
  if (targetCh === '女频') return candCh === '女频';
  return candCh === targetCh || candCh === '共用';
}

export function findSameSignatureBooks(target, pool, limit = 8) {
  const author = String(target?.author || '').trim();
  if (!author || author === '佚名' || !Array.isArray(pool) || !pool.length) return [];
  const tid = String(target.id);
  const list = pool.filter((b) => String(b.id) !== tid && String(b.author || '').trim() === author);
  list.sort((a, b) => ((b.readers ?? 0) - (a.readers ?? 0)) || String(a.id).localeCompare(String(b.id)));
  return list.slice(0, limit);
}

let cachedPoolRef = null;
let cachedTagFreq = new Map();

function getTagFreq(pool) {
  if (pool === cachedPoolRef && cachedTagFreq.size) return cachedTagFreq;
  const freq = new Map();
  for (const b of pool) {
    for (const t of fineTagsOf(b)) {
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  cachedPoolRef = pool;
  cachedTagFreq = freq;
  return freq;
}

export function findSimilarBooks(target, pool, { relaxed = false, limit = 10 } = {}) {
  if (!target || !Array.isArray(pool) || !pool.length) {
    return { strict: [], relaxedList: [], canRelax: false, primaryName: '' };
  }
  const tid = String(target.id);
  const tgtPrims = Array.isArray(target.primary) ? target.primary : [];
  const tgtPrimSet = new Set(tgtPrims);
  const tgtFine = fineTagsOf(target);
  const tgtFineSet = new Set(tgtFine);
  const tagFreq = getTagFreq(pool);

  const strict = [];
  const relaxedList = [];

  for (const cand of pool) {
    const cid = String(cand.id);
    if (cid === tid) continue;
    if (!channelMatches(target.channel, cand.channel)) continue;

    const candPrims = Array.isArray(cand.primary) ? cand.primary : [];
    const sharedPrims = candPrims.filter((p) => tgtPrimSet.has(p));
    const sharedTags = [];
    let tagScore = 0;

    if (tgtFineSet.size) {
      for (const t of fineTagsOf(cand)) {
        if (!tgtFineSet.has(t)) continue;
        sharedTags.push(t);
        const f = tagFreq.get(t) || 50;
        tagScore += 1 / Math.sqrt(Math.max(3, f));
      }
    }

    if (sharedTags.length > 0) {
      sharedTags.sort((a, b) => (tagFreq.get(a) || 9999) - (tagFreq.get(b) || 9999));
      const topLabels = sharedTags.slice(0, 3);
      const reasonParts = [];
      if (sharedPrims.length) reasonParts.push(`同分类「${sharedPrims[0]}」`);
      reasonParts.push(`同为 ${topLabels.join(' + ')}`);
      const wordProx = Number.isFinite(target.words) && Number.isFinite(cand.words) && target.words > 0
        ? Math.max(0, 1 - Math.abs(Math.log10(Math.max(1, cand.words) / Math.max(1, target.words))) * 0.5)
        : 0;
      const totalScore =
        (sharedTags.length >= 2 ? 12 : 0) +
        tagScore * 18 +
        (sharedPrims.length ? 3.5 : 0) +
        (cand.status && cand.status === target.status ? 0.8 : 0) +
        wordProx +
        Math.min(1.5, Math.log10(Math.max(1000, cand.readers || 1000)) * 0.2);

      strict.push({
        book: cand,
        score: totalScore,
        reason: reasonParts.join(' · '),
        isRelaxed: false,
      });
    } else if (sharedPrims.length > 0) {
      const sameStatus = cand.status && cand.status === target.status;
      const reason = `同分类「${sharedPrims[0]}」${sameStatus ? ` · 同为${cand.status}` : ''}`;
      relaxedList.push({
        book: cand,
        score: (cand.readers || 0) + (cand.score || 0) * 5000 + (sameStatus ? 10000 : 0),
        reason,
        isRelaxed: true,
      });
    }
  }

  strict.sort((a, b) => (b.score - a.score) || ((b.book.readers ?? 0) - (a.book.readers ?? 0)));
  relaxedList.sort((a, b) => (b.score - a.score) || ((b.book.readers ?? 0) - (a.book.readers ?? 0)));

  return {
    strict: strict.slice(0, limit),
    relaxedList: relaxed ? relaxedList.slice(0, limit) : relaxedList.slice(0, Math.max(4, limit - Math.min(limit, strict.length))),
    canRelax: relaxedList.length > 0,
    primaryName: tgtPrims[0] || '',
  };
}

function renderMiniBookItem(entry, { showReason = true } = {}) {
  const b = entry.book || entry;
  const bid = String(b.id || '');
  const sc = Number.isFinite(b.score) && b.score > 0 ? `★ ${b.score.toFixed(1)}` : '';
  const metaParts = [fmtReaders(b.readers) + ' 在读', fmtWords(b.words), b.status, sc].filter(Boolean);
  return `<a class="dRelCard" href="?book=${encodeURIComponent(bid)}" data-open-book="${esc(bid)}">
    <div class="dRelTop"><b class="dRelTitle">${esc(b.title)}</b><span class="dRelArrow" aria-hidden="true">›</span></div>
    ${showReason && entry.reason ? `<div class="dRelReason">${esc(entry.reason)}</div>` : ''}
    <div class="dRelMeta">${metaParts.map(esc).join(' · ')}</div>
  </a>`;
}

export function renderDetailMarkup(ctx) {
  const {
    book,
    id,
    saved,
    coverUrl,
    trendObj,
    trendsPayload,
    radarPayload,
    startDate,
    stackDepth = 0,
    hasInSitePrev = false,
    coreReady = false,
    coreFailed = false,
    shardLoading = false,
    shardFailed = false,
    pool = [],
    similarRelaxed = false,
    introExpanded = false,
    toastMsg = '',
  } = ctx;

  const backLabel = stackDepth > 0 ? '← 返回上一本' : hasInSitePrev ? '← 返回列表' : '← 去搜作品';
  const showSearchLink = stackDepth > 0 && !hasInSitePrev;

  if (!book) {
    return `<div class="dTopBar">
      <button type="button" class="dBackBtn" id="detailBackBtn">${esc(backLabel)}</button>
      <div class="dTopOps">
        ${!hasInSitePrev && stackDepth === 0 ? '' : '<button type="button" class="dGhostBtn" id="detailGoSearch">去搜作品</button>'}
      </div>
    </div>
    <div class="dStateBox">
      ${shardLoading
        ? `<div class="dStateTitle">正在读取《${esc(id)}》作品档案…</div><p class="dStateSub">冷启动直达仅加载目标单书分片，无需等待整库下载。</p>`
        : shardFailed
          ? `<div class="dStateTitle">作品档案加载失败</div><p class="dStateSub">可能由于网络超时或波动，未完整取得单书分片数据。</p><button type="button" class="dPrimaryBtn" id="detailShardRetry">重新加载档案</button>`
          : `<div class="dStateTitle">暂未在当前书库中找到该作品（${esc(id)}）</div><p class="dStateSub">可能已被下架隔离或未达收录门槛，仍可直接前往番茄官网核验。</p><div class="dStateBtns"><a class="dPrimaryBtn" target="_blank" rel="noopener" href="https://fanqienovel.com/page/${encodeURIComponent(id)}">前往番茄网页版查看 ↗</a></div>`}
    </div>`;
  }

  const readAct = resolveReadAction(book);
  const primList = Array.isArray(book.primary) ? book.primary : [];
  const tags = fineTagsOf(book);
  const atDate = trendsPayload?.latestDate || radarPayload?.latestRankDate || dayString();
  const ageStr = fmtAge(startDate, atDate);
  const updStr = fmtLastUpdate(book.lastUpdate);
  const wordFmt = fmtWords(book.words);
  const specs = [wordFmt, book.status, ageStr, updStr].filter(Boolean);
  const tone = Number(String(book.id).slice(-2)) % 4 || 0;
  const tqTitle = String(book.title || '').replace(/[：:·\s].*$/, '').slice(0, 5) || String(book.title || '').slice(0, 5);

  const readersVal = Number.isFinite(trendObj?.readers) ? trendObj.readers : book.readers;
  const scoreVal = Number.isFinite(book.score) && book.score > 0 ? book.score : null;
  const scoreCntStr = fmtScoreCnt(book.scoreCount);
  const m1 = trendObj ? windowMetric(trendObj, 1, trendsPayload?.dates) : { d: null };
  const m7 = trendObj ? windowMetric(trendObj, 7, trendsPayload?.dates) : { d: null };

  const introText = (book.intro || '').trim();
  const introParas = introText ? introText.split(/\n+/).map((s) => s.trim()).filter(Boolean) : [];
  const isLongIntro = introText.length > 150 || introParas.length > 3;

  const badgeHtml = renderRankBadges(radarPayload, book.id, book._badges || book.badges);
  const trendDataObj = trendObj
    ? { latestDate: trendsPayload?.latestDate, dates: trendsPayload?.dates || [], books: { [String(book.id)]: [trendObj.readers, trendObj.d1, trendObj.p1, trendObj.d7, trendObj.p7, trendObj.d30, trendObj.p30, trendObj.dw1, trendObj.series] } }
    : null;
  const trendPanelHtml = trendDataObj
    ? renderTrendPanel(trendDataObj, book.id, 7)
    : '<div class="trendEmpty">暂无足够历史在读序列，次日采集后将自动生成折线。</div>';

  const hasPool = Array.isArray(pool) && pool.length > 0;
  const sameAuthor = (coreReady || (!coreFailed && hasPool))
    ? findSameSignatureBooks(book, pool, coreReady ? 8 : 6)
    : [];
  const simResult = (coreReady || (!coreFailed && hasPool))
    ? findSimilarBooks(book, pool, { relaxed: similarRelaxed, limit: coreReady ? 10 : 6 })
    : { strict: [], relaxedList: [], canRelax: false, primaryName: primList[0] || '' };

  let similarBodyHtml = '';
  if (!coreReady) {
    if (coreFailed) {
      similarBodyHtml = '<div class="dRelHint">全库索引加载超时，暂时无法匹配相近作品。<button type="button" class="syncRetryBtn" data-retry-sync="1">重试全库</button></div>';
    } else if (simResult.strict.length > 0) {
      similarBodyHtml = `<div class="dRelHint dRelSyncing">全库索引同步中，先展示热门库初步匹配（完成后自动补齐全库 2.6 万本）…</div><div class="dRelList">${simResult.strict.map((e) => renderMiniBookItem(e)).join('')}</div>`;
    } else if (simResult.relaxedList.length > 0) {
      similarBodyHtml = `<div class="dRelHint dRelSyncing">全库索引同步中，先展示热门库同分类初步匹配（完成后自动补齐全库 2.6 万本）…</div><div class="dRelList">${simResult.relaxedList.map((e) => renderMiniBookItem(e)).join('')}</div>`;
    } else {
      similarBodyHtml = '<div class="dRelHint">正在同步全库索引（首次同步完成后将自动缓存至本机，秒开推荐）…</div>';
    }
  } else {
    const strictCards = simResult.strict.map((e) => renderMiniBookItem(e)).join('');
    const showRelaxNow = similarRelaxed || simResult.strict.length === 0;
    const relaxCards = showRelaxNow ? simResult.relaxedList.map((e) => renderMiniBookItem(e)).join('') : '';
    const relaxBtnHtml = !showRelaxNow && simResult.canRelax && simResult.strict.length < 6
      ? `<button type="button" class="dRelaxBtn" id="detailRelaxBtn">放宽条件：再看「${esc(simResult.primaryName || '同分类')}」更多作品 ▾</button>`
      : '';
    if (!strictCards && !relaxCards) {
      similarBodyHtml = '<div class="dRelHint">当前书库暂无高度匹配的相近作品，可直接点上方分类标签去搜作品探索。</div>';
    } else {
      similarBodyHtml = (strictCards ? `<div class="dRelList">${strictCards}</div>` : '<div class="dRelHint">未找到重叠细题材作品，已自动放宽至同主分类：</div>')
        + relaxBtnHtml
        + (relaxCards ? `<div class="dRelSubHead">同主分类拓展</div><div class="dRelList">${relaxCards}</div>` : '');
    }
  }

  let authorBodyHtml = '';
  if (!book.author || book.author === '佚名') {
    authorBodyHtml = '<div class="dRelHint">该作品暂无署名信息。</div>';
  } else if (!coreReady) {
    if (coreFailed) {
      authorBodyHtml = `<div class="dRelHint">全库加载失败，暂未查询「${esc(book.author)}」其他作品。<button type="button" class="syncRetryBtn" data-retry-sync="1">重试全库</button></div>`;
    } else if (sameAuthor.length > 0) {
      authorBodyHtml = `<div class="dRelHint dRelSyncing">全库同步中，先展示热门库已发现同署名作品…</div><div class="dRelList">${sameAuthor.map((b) => renderMiniBookItem({ book: b }, { showReason: false })).join('')}</div>`;
    } else {
      authorBodyHtml = `<div class="dRelHint">正在同步全库以查询「${esc(book.author)}」同署名作品…</div>`;
    }
  } else if (!sameAuthor.length) {
    authorBodyHtml = `<div class="dRelHint">当前库（≥8,000 在读）暂未收录「${esc(book.author)}」的其他作品。</div>`;
  } else {
    authorBodyHtml = `<div class="dRelList">${sameAuthor.map((b) => renderMiniBookItem({ book: b }, { showReason: false })).join('')}</div>`;
  }

  return `<div class="dTopBar">
    <button type="button" class="dBackBtn" id="detailBackBtn">${esc(backLabel)}</button>
    <div class="dTopOps">
      ${showSearchLink ? '<button type="button" class="dGhostBtn" id="detailGoSearch">回搜作品</button>' : ''}
      <button type="button" class="dGhostBtn" id="detailCopyLink">分享链接</button>
    </div>
  </div>

  <div class="dGrid">
    <div class="dMainCol">
      <section class="dCard dHeroCard" aria-label="作品档案">
        <div class="dHeroHead">
          <div class="dCoverBox">
            <span class="tiqian" data-tone="${tone}" aria-hidden="true"><em class="tqCat">${esc(primList[0] || '精选')}</em><b class="tqTitle">${esc(tqTitle)}</b></span>
            ${coverUrl ? `<img class="coverImg" src="${esc(coverUrl)}" referrerpolicy="no-referrer" alt="${esc(book.title)}封面">` : ''}
          </div>
          <div class="dHeroMeta">
            <h1 class="dTitle">${esc(book.title)}</h1>
            <div class="dAuthorRow">
              <span>作者：</span><a href="#detailAuthor" class="dAuthorJump" title="查看同署名作品">${esc(book.author || '未知')}</a>
              ${book.channel ? `<span class="dChTag">${esc(book.channel)}</span>` : ''}
            </div>
            <div class="dSpecs">${specs.map(esc).join(' · ')}</div>
            <div class="dCatsLine">
              ${primList.map((c) => `<a class="dCatChip" data-category="${esc(c)}" href="?category=${encodeURIComponent(c)}">${esc(c)}</a>`).join('')}
              ${tags.slice(0, 8).map((t) => `<a class="dTagChip" data-tag="${esc(t)}" href="?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}
            </div>
          </div>
        </div>
      </section>

      <section class="dCard dIntroCard" aria-label="作品简介与导读">
        <div class="dSecHead">
          <h2>作品简介</h2>
          <a href="#detailSimilar" class="dJumpSimBtn" id="detailJumpSimilar">找相似 ↓</a>
        </div>
        ${introParas.length
          ? `<div class="dIntroBody${isLongIntro && !introExpanded ? ' clamped' : ''}" id="detailIntroBody">${introParas.map((p, i) => `<p${i === 0 && (p.startsWith('【') || p.includes('｜') || p.includes('|')) ? ' class="blurbHook"' : ''}>${esc(p)}</p>`).join('')}</div>
             ${isLongIntro ? `<button type="button" class="dIntroToggle" id="detailIntroToggle" aria-expanded="${introExpanded}">${introExpanded ? '收起简介 ▴' : '展开全部简介 ▾'}</button>` : ''}`
          : '<p class="dIntroMissing">当前暂无简介（资料待补），可直接前往番茄官方查看最新章节与导读。</p>'}
      </section>

      <section class="dCard dActCard" aria-label="阅读与收藏操作">
        <div class="dActRow">
          <a class="dPrimaryBtn dReadPrimary" id="detailReadPrimary" data-kind="${readAct.primary.kind}" data-book-id="${esc(book.id)}" data-book-title="${esc(book.title)}" href="${esc(readAct.primary.href)}"${readAct.primary.kind === 'web' ? ' target="_blank" rel="noopener"' : ''}>${esc(readAct.primary.label)}</a>
          ${readAct.secondary ? `<a class="dSecBtn" href="${esc(readAct.secondary.href)}" target="_blank" rel="noopener">${esc(readAct.secondary.label)}</a>` : ''}
          <button type="button" class="dFavBtn${saved ? ' active' : ''}" id="detailFavBtn" aria-pressed="${saved}">${saved ? '★ 已加入书篓' : '☆ 加入书篓'}</button>
        </div>
        <div class="dToast" id="detailToast" role="status"${toastMsg ? '' : ' hidden'}>${esc(toastMsg)}</div>
      </section>

      <section class="dCard dStatsCard" aria-label="在读表现与走势">
        <div class="dStatStrip">
          <div class="dStatItem">
            <small>当前在读 · 番茄实测</small>
            <b>${esc(fmtReaders(readersVal))}</b>
            <div class="dStatDeltas">
              ${Number.isFinite(m1.d) ? `<span class="deltaPill ${deltaClass(m1.d)}">${esc(dayLabel(trendsPayload?.latestDate))} ${esc(shortDelta(m1.d))}${Number.isFinite(m1.p) ? ' (' + esc(formatPct(m1.p)) + ')' : ''}</span>` : ''}
              ${Number.isFinite(m7.d) ? `<span class="deltaPill ${deltaClass(m7.d)}">近7天 ${esc(shortDelta(m7.d))}${Number.isFinite(m7.p) ? ' (' + esc(formatPct(m7.p)) + ')' : ''}</span>` : ''}
            </div>
          </div>
          <div class="dStatItem">
            <small>官方评分 · 番茄实测</small>
            <b>${scoreVal !== null ? `★ ${scoreVal.toFixed(1)}` : '暂无评分'}</b>
            <span class="dStatNote">${scoreCntStr ? esc(scoreCntStr) : '官方评分待补充'}</span>
          </div>
        </div>
        <div class="dTrendWrap" id="detailTrendWrap">${trendPanelHtml}</div>
      </section>
    </div>

    <aside class="dSideCol">
      ${badgeHtml ? `<section class="dCard dSideCard" aria-label="上榜履历">
        <div class="dSecHead"><h2>上榜履历</h2><span class="dSrcNote">本站观测期</span></div>
        ${badgeHtml}
      </section>` : ''}

      <section class="dCard dSideCard" id="detailSimilar" aria-label="相近作品推荐">
        <div class="dSecHead"><h2>相近作品</h2><span class="dSrcNote">基于标签与分类</span></div>
        ${similarBodyHtml}
      </section>

      <section class="dCard dSideCard" id="detailAuthor" aria-label="同署名作品">
        <div class="dSecHead"><h2>同署名作品</h2><span class="dSrcNote">可能含同名作者</span></div>
        ${authorBodyHtml}
      </section>
    </aside>
  </div>`;
}
