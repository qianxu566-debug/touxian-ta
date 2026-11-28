import {
  DEFAULT_FATTEN_WORDS,
  MAX_HISTORY,
  MAX_BLOCKED_BOOKS,
  listShelfItems,
  listHistoryItems,
  getBlocks,
  totalBlockCount,
  getDefaultFattenWords,
  evaluateFattenAlerts,
  hasBook,
  hasNativeShelfBridge,
  getNativeAppVersion,
  shouldShowOldAppTip,
  getActiveIdentity,
} from './shelf.js?v=29';

const nf = new Intl.NumberFormat('zh-CN');
const wanNf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BLOCK_BOOKS_PAGE_SIZE = 20;
const QUICK_BLOCK_KEYWORDS = ['后宫', '圣母', '系统', '无女主', '虐主', '女尊', '替身', '马甲', '无CP', '种马'];

function fmtReaders(n) {
  if (!Number.isFinite(n)) return '暂无';
  return n >= 10000 ? `${wanNf.format(n / 10000)} 万` : nf.format(n);
}

function fmtWords(n) {
  if (!Number.isFinite(n)) return '';
  return n >= 10000 ? `${wanNf.format(n / 10000)}万字` : `${nf.format(n)}字`;
}

function fmtWanTarget(words) {
  const n = Number(words || DEFAULT_FATTEN_WORDS);
  return `${Number((n / 10000).toFixed(1))} 万字`;
}

function fmtRelTime(isoStr) {
  const ms = Date.parse(isoStr || '');
  if (!Number.isFinite(ms)) return '';
  const diffMin = Math.floor((Date.now() - ms) / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay} 天前`;
  return isoStr.slice(5, 10);
}

function shiftDateLocal(baseDateStr, addDays) {
  const clean = /^\d{4}-\d{2}-\d{2}$/.test(baseDateStr || '') ? baseDateStr : new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const d = new Date(`${clean}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + addDays);
  return d.toISOString().slice(0, 10);
}

function coverMarkup(id, title, prims, coverUrl) {
  const tone = Number(String(id).slice(-2)) % 4 || 0;
  const tqTitle = String(title || '').replace(/[：:·\s].*$/, '').slice(0, 5) || String(title || '').slice(0, 5);
  return `<a class="cover" href="?book=${encodeURIComponent(id)}" data-open-book="${esc(id)}">`
    + `<span class="tiqian" data-tone="${tone}" aria-hidden="true"><em class="tqCat">${esc(prims[0] || '精选')}</em><b class="tqTitle">${esc(tqTitle)}</b></span>`
    + (coverUrl ? `<img class="coverImg" loading="lazy" referrerpolicy="no-referrer" src="${esc(coverUrl)}" alt="${esc(title)}封面">` : '')
    + '</a>';
}

export function renderShelfViewMarkup(ctx) {
  const items = listShelfItems();
  const defaultTarget = getDefaultFattenWords();
  const {
    stateFilter = 'all',
    lookupBook,
    coverSource,
    resolveReadAction,
    latestObsDate = '',
    coreReady = false,
    radarReady = false,
    refNowSec = Math.floor(Date.now() / 1000),
    todayStr = '',
  } = ctx;

  const evaluated = items.map((it) => {
    const live = lookupBook(it.id);
    const fattenEval = evaluateFattenAlerts(it, live, refNowSec, defaultTarget, todayStr);
    const isLostCatalog = Boolean(coreReady && radarReady && !live);
    return { it, live, fattenEval, isLostCatalog };
  });

  const cntWant = evaluated.filter((x) => x.it.state === 'want').length;
  const cntReading = evaluated.filter((x) => x.it.state === 'reading').length;
  const cntDone = evaluated.filter((x) => x.it.state === 'done').length;
  const fattenItems = evaluated.filter((x) => x.it.fatten);
  const cntFatten = fattenItems.length;
  const unackedReadyItems = fattenItems.filter((x) => x.fattenEval.isUnackedReady);
  const unackedReadyCount = unackedReadyItems.length;

  const oldTipHtml = shouldShowOldAppTip()
    ? '<div class="shelfNotice"><div><b>升级提示（v2.1.1 已发布）：</b>检测到当前为旧版安卓壳。常规浏览与收藏已正常保存在本地；升级到新版 App 后，主/备双线路将共用同一份本机书篓并自动无损保留现有收藏。</div><div class="shelfNoticeOps"><button type="button" class="shelfNoticeBtn" id="oldAppCopyUrlBtn">复制官网短链去浏览器升级</button><span id="oldAppCopyState"></span></div></div>'
    : '';

  const headRowHtml = `<div class="shelfHeadRow">
    <h1 class="shelfPageTitle">书篓</h1>
  </div>`;

  const filterBar = `<div class="shelfFilterBar" role="tablist" aria-label="按阅读分组筛选">
    <button type="button" class="sfChip${stateFilter === 'all' ? ' active' : ''}" data-sf="all" aria-pressed="${stateFilter === 'all'}">全部 <em>${items.length}</em></button>
    <button type="button" class="sfChip${stateFilter === 'want' ? ' active' : ''}" data-sf="want" aria-pressed="${stateFilter === 'want'}">想看 <em>${cntWant}</em></button>
    <button type="button" class="sfChip${stateFilter === 'reading' ? ' active' : ''}" data-sf="reading" aria-pressed="${stateFilter === 'reading'}">在读 <em>${cntReading}</em></button>
    <button type="button" class="sfChip${stateFilter === 'done' ? ' active' : ''}" data-sf="done" aria-pressed="${stateFilter === 'done'}">已看 <em>${cntDone}</em></button>
    <button type="button" class="sfChip${stateFilter === 'fatten' ? ' active' : ''}" data-sf="fatten" aria-pressed="${stateFilter === 'fatten'}">🌱 养肥 <em>${cntFatten}</em>${unackedReadyCount ? `<span class="fattenAlertCnt" title="有 ${unackedReadyCount} 本养肥已达标">${unackedReadyCount}</span>` : ''}</button>
  </div>`;

  const ackMap = {};
  for (const x of unackedReadyItems) {
    if (x.fattenEval.eventKey) ackMap[x.it.id] = x.fattenEval.eventKey;
  }

  // Show banner ONLY when there is at least one unacknowledged ready book and not already in fatten tab
  const readyBannerHtml = (unackedReadyCount > 0 && stateFilter !== 'fatten')
    ? `<div class="fattenReadyBanner" data-fatten-ack-map="${esc(JSON.stringify(ackMap))}" role="status">
        <span class="fattenReadyTxt">🎉 有 <b>${unackedReadyCount}</b> 本养肥作品已达标可看</span>
        <div class="fattenReadyOps">
          <button type="button" class="fBannerGoBtn" id="fattenBannerGoBtn">去查看 ›</button>
          <button type="button" class="fBannerAckBtn" id="fattenBannerAckBtn">知道了</button>
        </div>
      </div>`
    : '';

  if (!items.length) {
    return {
      html: oldTipHtml + headRowHtml + filterBar
        + '<div class="shelfEmpty"><div class="shelfEmptyTitle">书篓还是空的</div><p>在任意书籍名片或作品详情页点击 <strong>☆ 加入书篓</strong>，或在详情页直接点 <strong>🌱 养肥</strong> 设定追更目标。</p><button type="button" class="dPrimaryBtn" id="shelfExploreBtn">去搜作品淘书</button></div>',
      counts: { items: 0, ready: unackedReadyCount },
    };
  }

  const visible = evaluated.filter(({ it }) => {
    if (stateFilter === 'fatten') return it.fatten;
    if (stateFilter === 'want' || stateFilter === 'reading' || stateFilter === 'done') return it.state === stateFilter;
    return true;
  });

  if (!visible.length) {
    return {
      html: oldTipHtml + headRowHtml + filterBar + readyBannerHtml
        + '<div class="shelfEmpty"><div class="shelfEmptyTitle">当前分组下暂无作品</div><p>可切换其他阅读状态或回到「全部」查看已收藏书目。</p><button type="button" class="dGhostBtn" data-sf="all">查看全部书篓</button></div>',
      counts: { items: items.length, ready: unackedReadyCount },
    };
  }

  const cards = visible.map(({ it, live, fattenEval, isLostCatalog }) => {
    const snap = it.snap || {};
    const title = live?.title || snap.title || (`作品 ${it.id}`);
    const author = live?.author || snap.author || '';
    const prims = (live?.primary?.length ? live.primary : snap.primary) || [];
    const words = Number.isFinite(live?.words) ? live.words : snap.words;
    const statusStr = live?.status || snap.status || '';
    const readersVal = Number.isFinite(live?.readers) ? live.readers : snap.readers;
    const scoreVal = (Number.isFinite(live?.score) && live.score > 0) ? live.score : (Number.isFinite(snap.score) && snap.score > 0 ? snap.score : null);
    const cover = live ? coverSource(live) : (snap.coverUrl && snap.coverUrl.startsWith('https://') ? snap.coverUrl : '');
    const obsDate = live ? (latestObsDate || snap.obsDate || '') : (snap.obsDate || '');
    const readAct = resolveReadAction({ id: it.id, title });
    const metaParts = [prims[0], author, fmtWords(words), statusStr, scoreVal !== null ? `★ ${scoreVal.toFixed(1)}` : ''].filter(Boolean);

    const stateSegHtml = `<div class="shelfStateSeg" role="group" aria-label="阅读状态">
      ${[['want', '想看'], ['reading', '在读'], ['done', '已看']].map(([k, lbl]) =>
        `<button type="button" class="ssBtn${it.state === k ? ' active' : ''}" data-shelf-state-id="${esc(it.id)}" data-shelf-state="${k}" aria-pressed="${it.state === k}">${lbl}</button>`
      ).join('')}
    </div>`;

    const fattenBtnHtml = `<button type="button" class="shelfFattenBtn${it.fatten ? ' active' : ''}" data-open-fatten-modal="${esc(it.id)}" aria-pressed="${it.fatten}">${it.fatten ? '🌱 养肥中' : '🌱 养肥'}</button>`;

    let fattenRowHtml = '';
    if (it.fatten) {
      const readyPills = fattenEval.alerts.map((a) => `<span class="fAlertPill ${esc(a.tone)}">${esc(a.label)}</span>`).join('');
      const warnPills = fattenEval.warnBadges.map((w) => `<span class="fAlertPill ${esc(w.tone)}">${esc(w.label)}</span>`).join('');
      let progText = '';
      if (!fattenEval.isReady) {
        if (fattenEval.mode === 'completed') {
          progText = `<span class="fProgText">🌱 等完结 · 当前 ${esc(statusStr || '连载状态待核')}</span>`;
        } else if (fattenEval.mode === 'date') {
          progText = `<span class="fProgText">🌱 ${esc(fattenEval.targetDesc)}</span>`;
        } else {
          progText = `<span class="fProgText">🌱 ${fmtWords(fattenEval.currentWords) || '待测'} / ${fmtWanTarget(fattenEval.targetWords)} (${fattenEval.progressPct}%)</span>`;
        }
      }
      fattenRowHtml = `<div class="shelfFattenRow">
        <div class="fattenAlertLine">${readyPills}${progText}${warnPills}<div class="fLineOps"><button type="button" class="fEditTargetBtn" data-open-fatten-modal="${esc(it.id)}">改目标</button><button type="button" class="fCancelInlineBtn" data-cancel-fatten="${esc(it.id)}">取消养肥</button></div></div>
      </div>`;
    }

    return `<article class="shelfItem${isLostCatalog ? ' isLost' : ''}" data-id="${esc(it.id)}">
      ${coverMarkup(it.id, title, prims, cover)}
      <div class="shelfBody">
        <div class="shelfTop">
          <a class="shelfTitle" href="?book=${encodeURIComponent(it.id)}" data-open-book="${esc(it.id)}">${esc(title)}</a>
          ${isLostCatalog ? '<span class="shelfLostPill" title="该作品暂时未出现在最新全库快照中，已为你保留本机档案">当前未收录 · 保留原档案</span>' : ''}
        </div>
        <div class="shelfMeta">${metaParts.map(esc).join(' · ')}</div>
        <div class="shelfControlsLine">${stateSegHtml}${fattenBtnHtml}</div>
        ${fattenRowHtml}
        <div class="shelfObs"><span>在读 <b>${esc(fmtReaders(readersVal))}</b></span>${obsDate ? `<small>${isLostCatalog ? '失收录前实测 ' : '最后实测 '}${esc(obsDate.slice(5))}</small>` : ''}</div>
        <div class="shelfOps">
          <a class="readApp" data-book-id="${esc(it.id)}" data-book-title="${esc(title)}" data-kind="${esc(readAct.primary.kind)}" href="${esc(readAct.primary.href)}"${readAct.primary.kind === 'web' ? ' target="_blank" rel="noopener"' : ''}>${esc(readAct.primary.kind === 'app' ? '番茄读 ↗' : '网页读 ↗')}</a>
          <button type="button" class="shelfDetailBtn" data-open-book="${esc(it.id)}">详情</button>
          <button type="button" class="shelfRemoveBtn" data-shelf-remove="${esc(it.id)}">移出</button>
        </div>
      </div>
    </article>`;
  }).join('');

  return {
    html: oldTipHtml + headRowHtml + filterBar + readyBannerHtml + `<div class="shelfGrid">${cards}</div>`,
    counts: { items: items.length, ready: unackedReadyCount },
  };
}

export function renderMyDrawerMarkup(ctx) {
  const {
    isLight = false,
    showAppInstall = false,
    appBtnLabel = '下载 App',
  } = ctx;
  const history = listHistoryItems();
  const totalBlocks = totalBlockCount();
  const ident = getActiveIdentity();
  const identLabel = ident === 'guest' ? '本机游客' : ident;
  const useNative = hasNativeShelfBridge();
  const host = (typeof location !== 'undefined' ? location.hostname : '').toLowerCase();
  const routeTag = host.includes('pages.dev') ? 'CF 主线' : host.includes('github.io') ? 'GH 备线' : '本地环境';
  const appVer = useNative ? (getNativeAppVersion() || '2.1.1') : '';
  const storageMeta = useNative
    ? `App v${appVer} · ${routeTag} · 双线路共享存储`
    : `${routeTag} · 当前浏览器本机存储`;

  return `<div class="myDrawerHead">
    <div class="myDrawerTitleWrap">
      <b>我的</b>
      <span class="myIdentTag">${esc(identLabel)}</span>
    </div>
    <button type="button" class="myDrawerClose" id="closeMyDrawerBtn" aria-label="关闭我的侧栏">✕</button>
  </div>

  <div class="myQuickControls">
    <div class="myQuickRow">
      <span>界面外观</span>
      <button type="button" class="drawerPillBtn" id="drawerThemeBtn">${isLight ? '☀️ 浅色（豆沙竹青）' : '🌙 深色（海石板）'}</button>
    </div>
    ${showAppInstall ? `<div class="myQuickRow">
      <span>安卓客户端</span>
      <button type="button" class="drawerPillBtn accent" id="drawerAppBtn">${esc(appBtnLabel)}</button>
    </div>` : ''}
  </div>

  <div class="myMenuList" role="menu" aria-label="功能入口">
    <button type="button" class="myMenuItem" data-open-mypage="history" role="menuitem">
      <div class="myMenuText">
        <b>浏览足迹</b>
        <small>最近打开过的作品记录（最多 ${MAX_HISTORY} 本）</small>
      </div>
      <span class="myMenuRight"><em>${history.length}</em><i>›</i></span>
    </button>
    <button type="button" class="myMenuItem" data-open-mypage="blocks" role="menuitem">
      <div class="myMenuText">
        <b>屏蔽管理</b>
        <small>单书搜索管理 · 分类题材多选 · 关键词</small>
      </div>
      <span class="myMenuRight"><em>${totalBlocks}</em><i>›</i></span>
    </button>
    <button type="button" class="myMenuItem" data-open-mypage="backup" role="menuitem">
      <div class="myMenuText">
        <b>备份与恢复</b>
        <small>复制备份内容 · 合并或覆盖恢复本机数据</small>
      </div>
      <span class="myMenuRight"><i>›</i></span>
    </button>
  </div>

  <div class="myDrawerFoot">
    <div class="myDrawerAccountHint">后续版本将在此直接接入账号登录与跨设备书篓云同步（浏览足迹仍仅存本机）</div>
    <div class="myDrawerEnvLine"><span class="${useNative ? 'dotLive' : 'dotLocal'}"></span>${esc(storageMeta)}</div>
  </div>`;
}

function renderHistoryPageBody(ctx) {
  const { confirmAction, lookupBook, coverSource } = ctx;
  const history = listHistoryItems();
  const clearBtnLabel = confirmAction === 'clearHistory' ? '确认清空全部足迹？' : '清空足迹';
  const headHtml = `<div class="shelfSubHeadBar">
    <span>最近浏览 <b>${history.length}</b> / ${MAX_HISTORY} 本（归属当前本机游客，点任意书可回看详情）</span>
    ${history.length ? `<button type="button" class="shelfDangerBtn${confirmAction === 'clearHistory' ? ' armed' : ''}" id="clearHistoryBtn">${clearBtnLabel}</button>` : ''}
  </div>`;

  if (!history.length) {
    return headHtml + '<div class="shelfEmpty"><div class="shelfEmptyTitle">暂无浏览足迹</div><p>在站内打开任意作品详情页，都会自动记录到这里（最多保留最近 50 本，且不会传至云端）。</p><button type="button" class="dPrimaryBtn" id="mySubExploreBtn">去搜作品逛逛</button></div>';
  }

  const cards = history.map((h) => {
    const live = lookupBook(h.id);
    const snap = h.snap || {};
    const title = live?.title || snap.title || `作品 ${h.id}`;
    const author = live?.author || snap.author || '';
    const prims = (live?.primary?.length ? live.primary : snap.primary) || [];
    const words = Number.isFinite(live?.words) ? live.words : snap.words;
    const readersVal = Number.isFinite(live?.readers) ? live.readers : snap.readers;
    const cover = live ? coverSource(live) : (snap.coverUrl && snap.coverUrl.startsWith('https://') ? snap.coverUrl : '');
    const saved = hasBook(h.id);
    const meta = [prims[0], author, fmtWords(words), `在读 ${fmtReaders(readersVal)}`].filter(Boolean);
    return `<article class="shelfItem histItem" data-id="${esc(h.id)}">
      ${coverMarkup(h.id, title, prims, cover)}
      <div class="shelfBody">
        <div class="shelfTop">
          <a class="shelfTitle" href="?book=${encodeURIComponent(h.id)}" data-open-book="${esc(h.id)}">${esc(title)}</a>
          <span class="histTime">${esc(fmtRelTime(h.viewedAt))}</span>
        </div>
        <div class="shelfMeta">${meta.map(esc).join(' · ')}</div>
        <div class="shelfOps">
          <button type="button" class="shelfDetailBtn" data-open-book="${esc(h.id)}">看详情</button>
          <button type="button" class="shelfFavMiniBtn${saved ? ' active' : ''}" data-hist-fav="${esc(h.id)}">${saved ? '★ 已在书篓' : '☆ 收进书篓'}</button>
          <button type="button" class="shelfRemoveBtn" data-hist-remove="${esc(h.id)}">删除</button>
        </div>
      </div>
    </article>`;
  }).join('');

  return headHtml + `<div class="shelfGrid">${cards}</div>`;
}

function renderBlocksPageBody(ctx) {
  const {
    confirmAction = '',
    blockSubTab = 'books',
    blockBookQuery = '',
    blockBookPage = 1,
    quickTagsPool = [],
  } = ctx;
  const blocks = getBlocks();
  const totalBlocks = totalBlockCount();
  const activeTab = ['books', 'tags', 'keywords'].includes(blockSubTab) ? blockSubTab : 'books';
  const clearBtnLabel = confirmAction === 'clearBlocks' ? '确认清空全部屏蔽？' : '清空全部';

  const topNote = `<div class="blockScopeNote">
    <div><strong>防误伤说明：</strong>作品屏蔽<strong>仅按单书生效</strong>（不影响作者名下其他书）；排行榜命中时原名次淡化折叠，其他列表直接隐藏。</div>
    ${totalBlocks ? `<button type="button" class="shelfDangerBtn${confirmAction === 'clearBlocks' ? ' armed' : ''}" id="clearBlocksBtn">${clearBtnLabel}</button>` : ''}
  </div>`;

  const subTabs = `<div class="blockSubTabs" role="tablist" aria-label="屏蔽类型切换">
    <button type="button" class="bstBtn${activeTab === 'books' ? ' active' : ''}" data-block-subtab="books">已屏蔽单书 <em>${blocks.books.length}</em></button>
    <button type="button" class="bstBtn${activeTab === 'tags' ? ' active' : ''}" data-block-subtab="tags">屏蔽标签 <em>${blocks.tags.length}</em></button>
    <button type="button" class="bstBtn${activeTab === 'keywords' ? ' active' : ''}" data-block-subtab="keywords">屏蔽关键词 <em>${blocks.keywords.length}</em></button>
  </div>`;

  let panelHtml = '';
  if (activeTab === 'books') {
    const qClean = String(blockBookQuery || '').trim();
    const qLower = qClean.normalize('NFKC').toLowerCase();
    // Filter ACROSS THE ENTIRE blocked books collection BEFORE pagination
    const matched = qLower
      ? blocks.books.filter((b) =>
          (b.title || '').normalize('NFKC').toLowerCase().includes(qLower) ||
          (b.author || '').normalize('NFKC').toLowerCase().includes(qLower) ||
          String(b.id || '').includes(qLower)
        )
      : blocks.books;
    const totalPages = Math.max(1, Math.ceil(matched.length / BLOCK_BOOKS_PAGE_SIZE));
    const curPage = Math.min(Math.max(1, Number(blockBookPage) || 1), totalPages);
    const start = (curPage - 1) * BLOCK_BOOKS_PAGE_SIZE;
    const slice = matched.slice(start, start + BLOCK_BOOKS_PAGE_SIZE);

    const searchRow = `<div class="blockSearchRow">
      <div class="blockSearchInputWrap">
        <input type="search" id="blockBookSearchInput" value="${esc(blockBookQuery)}" placeholder="在已屏蔽作品中搜索书名或作者…">
        ${qClean ? '<button type="button" class="blockSearchClear" id="blockBookSearchClear" aria-label="清空搜索">✕</button>' : ''}
      </div>
      <span class="blockSearchMeta">${qClean ? `匹配 ${matched.length} / ${blocks.books.length} 本` : `共 ${blocks.books.length} / ${MAX_BLOCKED_BOOKS} 本`}</span>
    </div>`;

    let listHtml = '';
    if (!blocks.books.length) {
      listHtml = '<div class="blockEmptyHint">暂无单书屏蔽（可在任意作品详情页点击「屏蔽此书」添加）。</div>';
    } else if (!matched.length) {
      listHtml = '<div class="blockEmptyHint">没有找到匹配「' + esc(qClean) + '」的已屏蔽作品。</div>';
    } else {
      listHtml = `<div class="blockBookList">${slice.map((b) =>
        `<div class="blockBookRow">
          <div class="blockBookInfo">
            <a class="blockBookLink" href="?book=${encodeURIComponent(b.id)}" data-open-book="${esc(b.id)}">${esc(b.title || `作品 ${b.id}`)}</a>
            ${b.author ? `<span class="blockBookAuthor"> · ${esc(b.author)}</span>` : ''}
          </div>
          <button type="button" class="shelfDetailBtn" data-unblock-book="${esc(b.id)}">取消屏蔽</button>
        </div>`
      ).join('')}</div>`;
    }

    const pagerHtml = totalPages > 1
      ? `<div class="blockPager">
          <button type="button" class="shelfDetailBtn" data-block-page="${curPage - 1}"${curPage <= 1 ? ' disabled' : ''}>上一页</button>
          <span>第 ${curPage} / ${totalPages} 页</span>
          <button type="button" class="shelfDetailBtn" data-block-page="${curPage + 1}"${curPage >= totalPages ? ' disabled' : ''}>下一页</button>
        </div>`
      : '';

    panelHtml = `<section class="blockCard">${searchRow}${listHtml}${pagerHtml}</section>`;
  } else if (activeTab === 'tags') {
    const blockedTagSet = new Set(blocks.tags);
    const suggestTags = quickTagsPool.filter((t) => !blockedTagSet.has(t)).slice(0, 8);
    const tagsHtml = blocks.tags.length
      ? `<div class="blockChipList">${blocks.tags.map((t) =>
          `<button type="button" class="blockChip" data-unblock-tag="${esc(t)}">${esc(t)} ×</button>`
        ).join('')}</div>`
      : '<div class="blockEmptyHint">暂未屏蔽任何分类或题材标签。</div>';

    panelHtml = `<section class="blockCard">
      <div class="blockTagPickerRow">
        <button type="button" class="dPrimaryBtn" id="openBlockTagPickerBtn">+ 搜索并多选屏蔽标签</button>
        <span class="blockTagHint">直接从当前书库分类与细题材库勾选，避免手输错字</span>
      </div>
      <form class="blockAddForm" id="blockTagForm">
        <input type="text" id="blockTagInput" placeholder="或手动补充自定义标签名称" maxlength="32">
        <button type="submit">添加</button>
      </form>
      ${suggestTags.length ? `<div class="blockSuggestRow"><span>常用推荐：</span>${suggestTags.map((t) => `<button type="button" class="blockSuggestBtn" data-add-block-tag="${esc(t)}">+ ${esc(t)}</button>`).join('')}</div>` : ''}
      ${tagsHtml}
    </section>`;
  } else {
    const blockedKwSet = new Set(blocks.keywords.map((k) => k.normalize('NFKC').toLowerCase()));
    const quickKws = QUICK_BLOCK_KEYWORDS.filter((k) => !blockedKwSet.has(k.normalize('NFKC').toLowerCase()));
    const kwsHtml = blocks.keywords.length
      ? `<div class="blockChipList">${blocks.keywords.map((k) =>
          `<button type="button" class="blockChip kw" data-unblock-kw="${esc(k)}">${esc(k)} ×</button>`
        ).join('')}</div>`
      : '<div class="blockEmptyHint">暂无屏蔽关键词。</div>';

    panelHtml = `<section class="blockCard">
      <form class="blockAddForm" id="blockKwForm">
        <input type="text" id="blockKwInput" placeholder="输入关键词（匹配书名 / 简介 / 标签，如：圣母、后宫）" maxlength="40">
        <button type="submit">添加</button>
      </form>
      ${quickKws.length ? `<div class="blockSuggestRow"><span>快捷排雷词：</span>${quickKws.map((k) => `<button type="button" class="blockSuggestBtn" data-add-block-kw="${esc(k)}">+ ${esc(k)}</button>`).join('')}</div>` : ''}
      ${kwsHtml}
    </section>`;
  }

  return topNote + subTabs + panelHtml;
}

function renderBackupPageBody(ctx) {
  const {
    isAndroidApp = false,
    backupDraftText = '',
    backupPreview = null,
    backupImportMode = 'merge',
    backupReplaceArmed = false,
    backupErrorMsg = '',
    backupExportMsg = '',
  } = ctx;
  const itemsCount = listShelfItems().length;
  const historyCount = listHistoryItems().length;
  const totalBlocks = totalBlockCount();

  let previewHtml = '';
  if (backupPreview) {
    const it = backupPreview.items;
    const hist = backupPreview.history;
    const blk = backupPreview.blocks;
    const prefs = backupPreview.prefs;
    const warns = backupPreview.warnings || [];
    const isReplace = backupImportMode === 'replace';
    const applyLabel = isReplace
      ? (backupReplaceArmed ? `再次确认：覆盖现有 ${it.currentTotal} 本收藏` : '确认覆盖恢复（不可撤销）')
      : '确认合并恢复';

    previewHtml = `<div class="backupPreviewCard" id="backupPreviewCard">
      <div class="bpTitle">恢复内容预览（尚未写入本机，确认后生效）</div>
      ${warns.length ? `<div class="bpWarn">${warns.map(esc).join('；')}</div>` : ''}
      <ul class="bpDiffList">
        <li><b>书篓作品</b>：备份包共 ${it.incomingTotal} 本 → <strong>新增 +${it.added}</strong> · <strong>更新 ${it.updated}</strong> · 保持 ${it.kept} → 合并后共 <b>${it.mergedTotal}</b> 本</li>
        <li><b>游客足迹</b>：合并后新增 +${hist.added} 条 → 共 <b>${hist.mergedTotal}</b> 条（上限 ${MAX_HISTORY}）</li>
        <li><b>屏蔽规则</b>：单书 +${blk.booksAdded} · 标签 +${blk.tagsAdded} · 关键词 +${blk.keywordsAdded} → 共 <b>${blk.mergedTotal}</b> 条</li>
        ${prefs.changed ? `<li><b>默认养肥目标</b>：${esc(fmtWanTarget(prefs.currentFattenWords))} → ${esc(fmtWanTarget(prefs.incomingFattenWords))}</li>` : ''}
      </ul>
      <div class="bpModeRow">
        <label><input type="radio" name="backupMode" value="merge"${!isReplace ? ' checked' : ''}> 合并到当前数据（推荐：保留现有并按最新记录补全）</label>
        <label class="bpReplaceOpt"><input type="radio" name="backupMode" value="replace"${isReplace ? ' checked' : ''}> 完全覆盖当前本机数据（清空原有收藏与屏蔽后按备份写入）</label>
      </div>
      ${isReplace ? `<div class="bpReplaceWarn">注意：选择「完全覆盖」将清除当前本机全部 ${it.currentTotal} 本收藏及现有屏蔽规则，请点击下方按钮两次以确认。</div>` : ''}
      <div class="bpActions">
        <button type="button" class="${isReplace && backupReplaceArmed ? 'shelfDangerBtn armed' : 'dPrimaryBtn'}" id="backupApplyBtn">${applyLabel}</button>
        <button type="button" class="dGhostBtn" id="backupCancelBtn">取消</button>
      </div>
    </div>`;
  }

  return `<div class="backupGrid">
    <section class="blockCard">
      <h3>导出本机备份</h3>
      <p class="backupDesc">打包当前 <strong>${itemsCount}</strong> 本书篓（保留想看/在读/已看与养肥设定）、<strong>${historyCount}</strong> 条游客足迹与 <strong>${totalBlocks}</strong> 条屏蔽规则。不依赖账号即可手动跨端迁移。</p>
      <div class="bpActions">
        <button type="button" class="dPrimaryBtn" id="backupCopyBtn">复制备份内容</button>
        ${isAndroidApp ? '' : '<button type="button" class="dGhostBtn" id="backupDownloadBtn">导出备份文件</button>'}
      </div>
      <div class="backupMsg" id="backupExportMsg" role="status">${esc(backupExportMsg)}</div>
    </section>
    <section class="blockCard">
      <h3>从备份恢复</h3>
      <p class="backupDesc">在下方粘贴之前复制的备份内容${isAndroidApp ? '' : '，或选择本地备份文件'}；系统会先核对数量并生成预览，确认后才写入本机。</p>
      ${isAndroidApp ? '' : '<div class="backupFileRow"><label class="backupFileBtn">选择备份文件<input type="file" id="backupFileInput" accept=".json,.txt,application/json,text/plain"></label></div>'}
      <textarea id="backupPasteInput" class="backupTextarea" rows="5" placeholder="在此粘贴备份内容…">${esc(backupDraftText)}</textarea>
      <div class="bpActions">
        <button type="button" class="shelfDetailBtn backupCheckBtn" id="backupPreviewBtn">核对并预览恢复内容</button>
      </div>
      ${backupErrorMsg ? `<div class="backupError" role="alert">${esc(backupErrorMsg)}</div>` : ''}
      ${previewHtml}
    </section>
  </div>`;
}

export function renderMySubPageMarkup(ctx) {
  const { page = 'history', backLabel = '返回' } = ctx;
  const titles = { history: '浏览足迹', blocks: '屏蔽管理', backup: '备份与恢复' };
  const title = titles[page] || '我的';

  let bodyHtml = '';
  if (page === 'blocks') bodyHtml = renderBlocksPageBody(ctx);
  else if (page === 'backup') bodyHtml = renderBackupPageBody(ctx);
  else bodyHtml = renderHistoryPageBody(ctx);

  return `<div class="subPageTopBar">
    <button type="button" class="dBackBtn" id="mySubBackBtn">← ${esc(backLabel)}</button>
    <h1 class="subPageTitle">${esc(title)}</h1>
    <div class="subPageSwitch" role="tablist" aria-label="我的功能切换">
      ${[['history', '足迹'], ['blocks', '屏蔽'], ['backup', '备份']].map(([k, lbl]) =>
        `<button type="button" class="spsBtn${page === k ? ' active' : ''}" data-switch-mypage="${k}">${lbl}</button>`
      ).join('')}
    </div>
  </div>
  <div class="subPageBody">${bodyHtml}</div>`;
}

export function renderFattenModalMarkup(ctx) {
  const {
    book = null,
    shelfItem = null,
    draftMode = 'words',
    draftWords = DEFAULT_FATTEN_WORDS,
    draftDate = '',
    rememberDefault = false,
    todayStr = '',
    errorMsg = '',
  } = ctx;

  const title = book?.title || shelfItem?.snap?.title || '设定养肥目标';
  const words = Number.isFinite(book?.words) ? book.words : shelfItem?.snap?.words;
  const statusStr = book?.status || shelfItem?.snap?.status || '';
  const stateMap = { want: '想看', reading: '在读', done: '已看' };
  const curStateLbl = stateMap[shelfItem?.state] || '想看';
  const curMode = ['words', 'completed', 'date'].includes(draftMode) ? draftMode : 'words';
  const wanVal = Number(((Number(draftWords) || DEFAULT_FATTEN_WORDS) / 10000).toFixed(1));
  const effDate = /^\d{4}-\d{2}-\d{2}$/.test(draftDate || '') ? draftDate : shiftDateLocal(todayStr, 14);

  let panelHtml = '';
  if (curMode === 'completed') {
    panelHtml = `<div class="fModalPane">
      <p class="fModalDesc">仅当作品在全库状态变为 <strong>「已完结」</strong> 时才提醒你可开宰；连载期间字数增长不会误触发提醒。</p>
    </div>`;
  } else if (curMode === 'date') {
    const presets = [[7, '7 天后'], [15, '15 天后'], [30, '30 天后'], [60, '60 天后']];
    panelHtml = `<div class="fModalPane">
      <div class="fTargetPresets">
        ${presets.map(([d, lbl]) => {
          const targetD = shiftDateLocal(todayStr, d);
          return `<button type="button" class="fPresetBtn${effDate === targetD ? ' active' : ''}" data-fatten-date-preset="${targetD}">${lbl}</button>`;
        }).join('')}
      </div>
      <div class="fModalInputRow">
        <label for="fattenDateInput">养肥到期日</label>
        <input type="date" id="fattenDateInput" value="${esc(effDate)}">
      </div>
      <p class="fModalDesc">到达设定日期（或作品提前完结）时，将在书篓顶部提醒你检查进度。</p>
    </div>`;
  } else {
    const wordPresets = [30, 50, 80, 100, 150];
    panelHtml = `<div class="fModalPane">
      <div class="fTargetPresets">
        ${wordPresets.map((w) =>
          `<button type="button" class="fPresetBtn${Math.round(Number(draftWords) / 10000) === w ? ' active' : ''}" data-fatten-word-preset="${w * 10000}">${w} 万字</button>`
        ).join('')}
      </div>
      <div class="fModalInputRow">
        <label for="fattenWordsInput">自定义目标</label>
        <input type="number" id="fattenWordsInput" min="5" max="1000" step="5" value="${wanVal}">
        <span>万字</span>
      </div>
      <label class="fModalCheck"><input type="checkbox" id="fattenRememberChk"${rememberDefault ? ' checked' : ''}> 将此字数设为以后默认目标</label>
      <p class="fModalDesc">当前 <b>${esc(fmtWords(words) || '字数待补充')}</b>${statusStr ? ` · ${esc(statusStr)}` : ''}；达标或提前完结时提醒，原「${esc(curStateLbl)}」状态保留不变。</p>
    </div>`;
  }

  return `<div class="wxCard fattenModalCard">
    <div class="fModalHead">
      <h3>设定养肥目标</h3>
      <button type="button" class="myDrawerClose" id="fattenModalCloseBtn" aria-label="关闭弹窗">✕</button>
    </div>
    <div class="fModalBook">《${esc(title)}》${shelfItem ? `<span class="fModalStateTag">保留原状态：${esc(curStateLbl)}</span>` : '<span class="fModalStateTag">将自动收入书篓</span>'}</div>
    <div class="fModalModes" role="tablist" aria-label="养肥目标类型">
      <button type="button" class="fModeBtn${curMode === 'words' ? ' active' : ''}" data-fatten-mode="words">按字数养</button>
      <button type="button" class="fModeBtn${curMode === 'completed' ? ' active' : ''}" data-fatten-mode="completed">等完结</button>
      <button type="button" class="fModeBtn${curMode === 'date' ? ' active' : ''}" data-fatten-mode="date">按日期养</button>
    </div>
    ${panelHtml}
    ${errorMsg ? `<div class="backupError" role="alert">${esc(errorMsg)}</div>` : ''}
    <div class="fModalFoot">
      <button type="button" class="dPrimaryBtn" id="fattenModalSaveBtn">保存养肥目标</button>
      ${shelfItem?.fatten ? `<button type="button" class="shelfDangerBtn" id="fattenModalOffBtn">取消养肥（保留${esc(curStateLbl)}）</button>` : ''}
      <button type="button" class="dGhostBtn" id="fattenModalCancelBtn">取消</button>
    </div>
  </div>`;
}

export function renderBlockTagModalMarkup(ctx) {
  const {
    categories = [],
    tags = [],
    draftSelected = new Set(),
    searchQuery = '',
  } = ctx;

  const qNorm = String(searchQuery || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
  const matchFilter = (name) => !qNorm || String(name || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '').includes(qNorm);

  const catMatches = categories.filter(matchFilter);
  const tagMatches = tags.filter(([t]) => matchFilter(t));
  const selectedList = [...draftSelected];

  return `<div class="wxCard blockTagModalCard">
    <div class="fModalHead">
      <h3>选择屏蔽标签</h3>
      <button type="button" class="myDrawerClose" id="blockTagCloseBtn" aria-label="关闭弹窗">✕</button>
    </div>
    <div class="btSearchWrap">
      <input type="search" id="blockTagSearchInput" value="${esc(searchQuery)}" placeholder="搜索主分类或题材（如：穿书、末世、无CP）…">
      ${searchQuery ? '<button type="button" class="blockSearchClear" id="blockTagSearchClear" aria-label="清空搜索">✕</button>' : ''}
    </div>
    <div class="btSelBar">
      <span>已勾选 <b>${selectedList.length}</b> 个屏蔽标签</span>
      ${selectedList.length ? '<button type="button" class="btClearSelBtn" id="blockTagClearSelBtn">清空勾选</button>' : ''}
    </div>
    <div class="btScrollArea">
      ${catMatches.length ? `<div class="btSecTitle">官方主分类（动态读取 · ${catMatches.length} 个）</div>
        <div class="btGrid">${catMatches.map((c) => {
          const on = draftSelected.has(c);
          return `<button type="button" class="btOpt${on ? ' active' : ''}" data-bt-pick="${esc(c)}" aria-pressed="${on}"><span>${esc(c)}</span>${on ? '<i>✓</i>' : ''}</button>`;
        }).join('')}</div>` : ''}
      ${tagMatches.length ? `<div class="btSecTitle">细题材标签（按作品数排序 · ${tagMatches.length} 个）</div>
        <div class="btGrid">${tagMatches.map(([t, cnt]) => {
          const on = draftSelected.has(t);
          return `<button type="button" class="btOpt${on ? ' active' : ''}" data-bt-pick="${esc(t)}" aria-pressed="${on}"><span>${esc(t)}</span><small>${nf.format(cnt)}</small></button>`;
        }).join('')}</div>` : ''}
      ${!catMatches.length && !tagMatches.length ? '<div class="blockEmptyHint">没有匹配的分类或题材标签。</div>' : ''}
    </div>
    <div class="fModalFoot">
      <button type="button" class="dPrimaryBtn" id="blockTagSaveBtn">确认保存（${selectedList.length} 项）</button>
      <button type="button" class="dGhostBtn" id="blockTagCancelBtn">取消</button>
    </div>
  </div>`;
}
