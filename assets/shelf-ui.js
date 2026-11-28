import {
  DEFAULT_FATTEN_WORDS,
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
} from './shelf.js?v=28';

const nf = new Intl.NumberFormat('zh-CN');
const wanNf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

function coverMarkup(id, title, prims, coverUrl) {
  const tone = Number(String(id).slice(-2)) % 4 || 0;
  const tqTitle = String(title || '').replace(/[：:·\s].*$/, '').slice(0, 5) || String(title || '').slice(0, 5);
  return `<a class="cover" href="?book=${encodeURIComponent(id)}" data-open-book="${esc(id)}">`
    + `<span class="tiqian" data-tone="${tone}" aria-hidden="true"><em class="tqCat">${esc(prims[0] || '精选')}</em><b class="tqTitle">${esc(tqTitle)}</b></span>`
    + (coverUrl ? `<img class="coverImg" loading="lazy" referrerpolicy="no-referrer" src="${esc(coverUrl)}" alt="${esc(title)}封面">` : '')
    + '</a>';
}

function renderStatusHeader(cnt) {
  const useNative = hasNativeShelfBridge();
  const host = (typeof location !== 'undefined' ? location.hostname : '').toLowerCase();
  const routeTag = host.includes('pages.dev') ? '主线 CF' : host.includes('github.io') ? '备线 GH' : '本地';
  const appVer = useNative ? (getNativeAppVersion() || '2.1.1') : '';
  const statusBarHtml = useNative
    ? `<div class="shelfStatusBar native"><span class="shelfStatusDot" aria-hidden="true"></span><b>已启用 App 共享书篓</b><span class="shelfStatusMeta">v${esc(appVer)} · ${esc(routeTag)} · 主/备双线路互通 · 共 ${cnt} 本</span></div>`
    : (!shouldShowOldAppTip()
      ? `<div class="shelfStatusBar"><span class="shelfStatusMeta">本机浏览器书篓 · 共 ${cnt} 本（仅保存在当前浏览器，可通过下方「备份」跨端迁移）</span></div>`
      : '');
  const tipHtml = shouldShowOldAppTip()
    ? '<div class="shelfNotice"><div><b>升级提示（v2.1.1 已发布）：</b>检测到当前为旧版安卓壳。常规浏览与收藏已正常保存在本地；升级到新版 App 后，主/备双线路将共用同一份本机书篓并自动无损保留现有收藏。</div><div class="shelfNoticeOps"><button type="button" class="shelfNoticeBtn" id="oldAppCopyUrlBtn">复制官网短链去浏览器升级</button><span id="oldAppCopyState"></span></div></div>'
    : '';
  return statusBarHtml + tipHtml;
}

function renderShelfTab(ctx, items, defaultTarget) {
  const {
    stateFilter,
    fattenEditId,
    lookupBook,
    coverSource,
    resolveReadAction,
    latestObsDate,
    coreReady,
    radarReady,
    refNowSec,
  } = ctx;

  const evaluated = items.map((it) => {
    const live = lookupBook(it.id);
    const fattenEval = evaluateFattenAlerts(it, live, refNowSec, defaultTarget);
    const isLostCatalog = Boolean(coreReady && radarReady && !live);
    return { it, live, fattenEval, isLostCatalog };
  });

  const cntWant = evaluated.filter((x) => x.it.state === 'want').length;
  const cntReading = evaluated.filter((x) => x.it.state === 'reading').length;
  const cntDone = evaluated.filter((x) => x.it.state === 'done').length;
  const fattenItems = evaluated.filter((x) => x.it.fatten);
  const cntFatten = fattenItems.length;
  const fattenAlertCount = fattenItems.filter((x) => x.fattenEval.hasAlert).length;
  const readyCount = fattenItems.filter((x) => x.fattenEval.alerts.some((a) => a.kind === 'words_ready')).length;
  const completedCount = fattenItems.filter((x) => x.fattenEval.alerts.some((a) => a.kind === 'completed')).length;
  const stalledCount = fattenItems.filter((x) => x.fattenEval.alerts.some((a) => a.kind === 'stalled')).length;

  const filterBar = `<div class="shelfFilterBar" role="tablist" aria-label="按书篓状态筛选">
    <button type="button" class="sfChip${stateFilter === 'all' ? ' active' : ''}" data-sf="all" aria-pressed="${stateFilter === 'all'}">全部 <em>${items.length}</em></button>
    <button type="button" class="sfChip${stateFilter === 'want' ? ' active' : ''}" data-sf="want" aria-pressed="${stateFilter === 'want'}">想看 <em>${cntWant}</em></button>
    <button type="button" class="sfChip${stateFilter === 'reading' ? ' active' : ''}" data-sf="reading" aria-pressed="${stateFilter === 'reading'}">在读 <em>${cntReading}</em></button>
    <button type="button" class="sfChip${stateFilter === 'done' ? ' active' : ''}" data-sf="done" aria-pressed="${stateFilter === 'done'}">已看 <em>${cntDone}</em></button>
    <button type="button" class="sfChip${stateFilter === 'fatten' ? ' active' : ''}" data-sf="fatten" aria-pressed="${stateFilter === 'fatten'}">🌱 养肥中 <em>${cntFatten}</em>${fattenAlertCount ? `<span class="fattenAlertCnt" title="有 ${fattenAlertCount} 本触发养肥提醒">${fattenAlertCount}</span>` : ''}</button>
  </div>`;

  let fattenControlHtml = '';
  if (stateFilter === 'fatten' || fattenAlertCount > 0 || cntFatten > 0) {
    const targetWan = Math.round((defaultTarget / 10000) * 10) / 10;
    const summaryBits = [];
    if (readyCount) summaryBits.push(`<span class="fSumTag up">达标可宰 ${readyCount}</span>`);
    if (completedCount) summaryBits.push(`<span class="fSumTag accent">已完结 ${completedCount}</span>`);
    if (stalledCount) summaryBits.push(`<span class="fSumTag warn">停更&gt;10天 ${stalledCount}</span>`);
    const summaryHtml = summaryBits.length
      ? `<div class="fattenSummary">${summaryBits.join('')}</div>`
      : (cntFatten ? '<div class="fattenSummary"><span class="fSumMuted">养肥中作品暂无达标/完结/停更提醒</span></div>' : '');

    fattenControlHtml = `<div class="fattenControlBar">
      ${summaryHtml}
      <div class="fattenTargetRow">
        <span class="fTargetLbl">默认养肥目标：<b>${esc(fmtWanTarget(defaultTarget))}</b></span>
        <div class="fTargetPresets">
          ${[30, 50, 80, 100].map((w) => `<button type="button" class="fPresetBtn${Math.round(defaultTarget / 10000) === w ? ' active' : ''}" data-fatten-preset="${w * 10000}">${w}万</button>`).join('')}
        </div>
        <form class="fTargetCustomForm" id="globalFattenForm">
          <input type="number" id="globalFattenInput" min="5" max="1000" step="5" value="${targetWan}" aria-label="默认养肥目标（万字）">
          <span>万字</span>
          <button type="submit" id="globalFattenApply">应用</button>
        </form>
      </div>
    </div>`;
  }

  if (!items.length) {
    return filterBar
      + fattenControlHtml
      + '<div class="shelfEmpty"><div class="shelfEmptyTitle">书篓还是空的</div><p>在任意书籍名片或作品详情页点击 <strong>☆ 加入书篓</strong>，可分别标记「想看 / 在读 / 已看」与「🌱 养肥」。</p><button type="button" class="dPrimaryBtn" id="shelfExploreBtn">去搜作品淘书</button></div>';
  }

  const visible = evaluated.filter(({ it }) => {
    if (stateFilter === 'fatten') return it.fatten;
    if (stateFilter === 'want' || stateFilter === 'reading' || stateFilter === 'done') return it.state === stateFilter;
    return true;
  });

  if (!visible.length) {
    return filterBar
      + fattenControlHtml
      + '<div class="shelfEmpty"><div class="shelfEmptyTitle">当前分类下暂无作品</div><p>可切换其他状态或回到「全部」查看已收藏书目。</p><button type="button" class="dGhostBtn" data-sf="all">查看全部书篓</button></div>';
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

    const fattenBtnHtml = `<button type="button" class="shelfFattenBtn${it.fatten ? ' active' : ''}" data-shelf-fatten-id="${esc(it.id)}" aria-pressed="${it.fatten}">${it.fatten ? '🌱 养肥中' : '养肥'}</button>`;

    let fattenRowHtml = '';
    if (it.fatten) {
      const alertPills = fattenEval.alerts.map((a) => `<span class="fAlertPill ${esc(a.tone)}">${esc(a.label)}</span>`).join('');
      const progText = !fattenEval.alerts.length
        ? `<span class="fProgText">养肥中 · ${fmtWords(fattenEval.currentWords) || '待测'} / ${fmtWanTarget(fattenEval.targetWords)} (${fattenEval.progressPct}%)</span>`
        : '';
      const isEditing = fattenEditId === it.id;
      const customWan = Math.round((fattenEval.targetWords / 10000) * 10) / 10;
      const editHtml = isEditing
        ? `<div class="fBookTargetEdit">
            <input type="number" class="fBookTargetInput" data-fatten-custom-input="${esc(it.id)}" min="5" max="1000" step="5" value="${customWan}" aria-label="本书养肥目标（万字）">
            <span>万字</span>
            <button type="button" class="fMiniSaveBtn" data-fatten-custom-save="${esc(it.id)}">保存</button>
            ${it.fattenTargetWords ? `<button type="button" class="fMiniResetBtn" data-fatten-custom-reset="${esc(it.id)}">用默认</button>` : ''}
          </div>`
        : '';
      fattenRowHtml = `<div class="shelfFattenRow">
        <div class="fattenAlertLine">${alertPills}${progText}<button type="button" class="fEditTargetBtn" data-fatten-edit="${esc(it.id)}">${isEditing ? '收起' : (it.fattenTargetWords ? `定制 ${fmtWanTarget(it.fattenTargetWords)}` : '改目标')}</button></div>
        ${editHtml}
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

  return filterBar + fattenControlHtml + `<div class="shelfGrid">${cards}</div>`;
}

function renderHistoryTab(ctx, history) {
  const { confirmAction, lookupBook, coverSource } = ctx;
  const clearBtnLabel = confirmAction === 'clearHistory' ? '确认清空全部足迹？' : '清空足迹';
  const headHtml = `<div class="shelfSubHeadBar">
    <span>最近浏览 <b>${history.length}</b> / 30 本（点击任意作品详情自动记录）</span>
    ${history.length ? `<button type="button" class="shelfDangerBtn${confirmAction === 'clearHistory' ? ' armed' : ''}" id="clearHistoryBtn">${clearBtnLabel}</button>` : ''}
  </div>`;

  if (!history.length) {
    return headHtml + '<div class="shelfEmpty"><div class="shelfEmptyTitle">暂无浏览足迹</div><p>在站内打开任意作品详情页，都会自动记录到此列表（最多保留最近 30 本）。</p><button type="button" class="dPrimaryBtn" id="shelfExploreBtn">去搜作品逛逛</button></div>';
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

function renderBlocksTab(ctx, blocks, totalBlocks) {
  const { confirmAction, quickTagsPool = [] } = ctx;
  const clearBtnLabel = confirmAction === 'clearBlocks' ? '确认清空全部屏蔽规则？' : '清空全部屏蔽';
  const blockedTagSet = new Set(blocks.tags);
  const suggestTags = quickTagsPool.filter((t) => !blockedTagSet.has(t)).slice(0, 8);

  const booksHtml = blocks.books.length
    ? `<div class="blockBookList">${blocks.books.map((b) =>
      `<div class="blockBookRow"><div><b>${esc(b.title || `作品 ${b.id}`)}</b>${b.author ? `<span> · ${esc(b.author)}</span>` : ''}</div><button type="button" class="shelfDetailBtn" data-unblock-book="${esc(b.id)}">取消屏蔽</button></div>`
    ).join('')}</div>`
    : '<div class="blockEmptyHint">暂无单书屏蔽（可在作品详情页点击「屏蔽此书」添加）。</div>';

  const tagsHtml = blocks.tags.length
    ? `<div class="blockChipList">${blocks.tags.map((t) =>
      `<button type="button" class="blockChip" data-unblock-tag="${esc(t)}">${esc(t)} ×</button>`
    ).join('')}</div>`
    : '<div class="blockEmptyHint">暂无屏蔽标签。</div>';

  const kwsHtml = blocks.keywords.length
    ? `<div class="blockChipList">${blocks.keywords.map((k) =>
      `<button type="button" class="blockChip kw" data-unblock-kw="${esc(k)}">${esc(k)} ×</button>`
    ).join('')}</div>`
    : '<div class="blockEmptyHint">暂无屏蔽关键词。</div>';

  return `<div class="blockScopeNote">
    <div><strong>精准防误伤规则：</strong>为避免误伤同名作者，作品屏蔽<strong>仅按单书生效</strong>；另支持按标签与关键词屏蔽。排行榜中命中的作品会在原名次淡化折叠，其他模式直接隐藏。</div>
    ${totalBlocks ? `<button type="button" class="shelfDangerBtn${confirmAction === 'clearBlocks' ? ' armed' : ''}" id="clearBlocksBtn">${clearBtnLabel}</button>` : ''}
  </div>
  <div class="blockPanels">
    <section class="blockCard">
      <h3>已屏蔽单书 <em>${blocks.books.length}</em></h3>
      ${booksHtml}
    </section>
    <section class="blockCard">
      <h3>屏蔽标签 <em>${blocks.tags.length}</em></h3>
      <form class="blockAddForm" id="blockTagForm">
        <input type="text" id="blockTagInput" placeholder="输入主分类或细题材（如：无CP、末世）" maxlength="32">
        <button type="submit">添加</button>
      </form>
      ${suggestTags.length ? `<div class="blockSuggestRow"><span>常用：</span>${suggestTags.map((t) => `<button type="button" class="blockSuggestBtn" data-add-block-tag="${esc(t)}">+ ${esc(t)}</button>`).join('')}</div>` : ''}
      ${tagsHtml}
    </section>
    <section class="blockCard">
      <h3>屏蔽关键词 <em>${blocks.keywords.length}</em></h3>
      <form class="blockAddForm" id="blockKwForm">
        <input type="text" id="blockKwInput" placeholder="匹配书名 / 简介 / 标签（如：圣母、后宫）" maxlength="40">
        <button type="submit">添加</button>
      </form>
      ${kwsHtml}
    </section>
  </div>`;
}

function renderBackupTab(ctx, itemsCount, historyCount, totalBlocks) {
  const { backupDraftText = '', backupPreview = null, backupImportMode = 'merge', backupErrorMsg = '' } = ctx;
  let previewHtml = '';
  if (backupPreview) {
    const it = backupPreview.items;
    const hist = backupPreview.history;
    const blk = backupPreview.blocks;
    const prefs = backupPreview.prefs;
    const warns = backupPreview.warnings || [];
    previewHtml = `<div class="backupPreviewCard" id="backupPreviewCard">
      <div class="bpTitle">导入合并预览（尚未写入本机，确认后生效）</div>
      ${warns.length ? `<div class="bpWarn">${warns.map(esc).join('；')}</div>` : ''}
      <ul class="bpDiffList">
        <li><b>书篓作品</b>：导入包共 ${it.incomingTotal} 本 → <strong>新增 +${it.added}</strong> · <strong>更新 ${it.updated}</strong> · 保持 ${it.kept} → 合并后共 <b>${it.mergedTotal}</b> 本</li>
        <li><b>浏览足迹</b>：导入后新增 +${hist.added} 条 → 合并后共 <b>${hist.mergedTotal}</b> 条（上限 30）</li>
        <li><b>屏蔽规则</b>：单书 +${blk.booksAdded} · 标签 +${blk.tagsAdded} · 关键词 +${blk.keywordsAdded} → 合并后共 <b>${blk.mergedTotal}</b> 条</li>
        ${prefs.changed ? `<li><b>默认养肥目标</b>：${esc(fmtWanTarget(prefs.currentFattenWords))} → ${esc(fmtWanTarget(prefs.incomingFattenWords))}</li>` : ''}
      </ul>
      <div class="bpModeRow">
        <label><input type="radio" name="backupMode" value="merge"${backupImportMode !== 'replace' ? ' checked' : ''}> 无损合并（推荐：保留现有并按最新时间戳补全）</label>
        <label><input type="radio" name="backupMode" value="replace"${backupImportMode === 'replace' ? ' checked' : ''}> 完全覆盖当前数据</label>
      </div>
      <div class="bpActions">
        <button type="button" class="dPrimaryBtn" id="backupApplyBtn">确认导入</button>
        <button type="button" class="dGhostBtn" id="backupCancelBtn">取消预览</button>
      </div>
    </div>`;
  }

  return `<div class="backupGrid">
    <section class="blockCard">
      <h3>导出本机备份</h3>
      <p class="backupDesc">包含当前 <strong>${itemsCount}</strong> 本书篓（含状态与养肥设定）、<strong>${historyCount}</strong> 条足迹与 <strong>${totalBlocks}</strong> 条屏蔽规则。不依赖云端，可随时跨设备恢复。</p>
      <div class="bpActions">
        <button type="button" class="dPrimaryBtn" id="backupDownloadBtn">下载 JSON 备份</button>
        <button type="button" class="dGhostBtn" id="backupCopyBtn">复制备份 JSON</button>
      </div>
      <div class="backupMsg" id="backupExportMsg" role="status"></div>
    </section>
    <section class="blockCard">
      <h3>导入校验与合并预览</h3>
      <p class="backupDesc">选择之前导出的 <code>.json</code> 文件或直接粘贴 JSON 文本，先核对新增与更新数量再决定合并或覆盖。</p>
      <div class="backupFileRow">
        <label class="backupFileBtn">选择 .json 备份文件<input type="file" id="backupFileInput" accept=".json,application/json"></label>
      </div>
      <textarea id="backupPasteInput" class="backupTextarea" rows="5" placeholder='粘贴 JSON 备份内容，例如 {"format":"touxian-ta-backup",...}'>${esc(backupDraftText)}</textarea>
      <div class="bpActions">
        <button type="button" class="shelfDetailBtn backupCheckBtn" id="backupPreviewBtn">校验并生成合并预览</button>
      </div>
      ${backupErrorMsg ? `<div class="backupError" role="alert">${esc(backupErrorMsg)}</div>` : ''}
      ${previewHtml}
    </section>
  </div>`;
}

export function renderShelfViewMarkup(ctx) {
  const items = listShelfItems();
  const history = listHistoryItems();
  const blocks = getBlocks();
  const totalBlocks = totalBlockCount();
  const defaultTarget = getDefaultFattenWords();
  const activeTab = ['shelf', 'history', 'blocks', 'backup'].includes(ctx.activeTab) ? ctx.activeTab : 'shelf';

  const headerHtml = renderStatusHeader(items.length);
  const subTabsHtml = `<div class="shelfSubTabs" role="tablist" aria-label="书篓功能分区">
    <button type="button" class="sstBtn${activeTab === 'shelf' ? ' active' : ''}" data-shelf-tab="shelf" aria-selected="${activeTab === 'shelf'}">书篓 <em>${items.length}</em></button>
    <button type="button" class="sstBtn${activeTab === 'history' ? ' active' : ''}" data-shelf-tab="history" aria-selected="${activeTab === 'history'}">足迹 <em>${history.length}</em></button>
    <button type="button" class="sstBtn${activeTab === 'blocks' ? ' active' : ''}" data-shelf-tab="blocks" aria-selected="${activeTab === 'blocks'}">屏蔽 <em>${totalBlocks}</em></button>
    <button type="button" class="sstBtn${activeTab === 'backup' ? ' active' : ''}" data-shelf-tab="backup" aria-selected="${activeTab === 'backup'}">备份</button>
  </div>`;

  let bodyHtml = '';
  if (activeTab === 'history') {
    bodyHtml = renderHistoryTab(ctx, history);
  } else if (activeTab === 'blocks') {
    bodyHtml = renderBlocksTab(ctx, blocks, totalBlocks);
  } else if (activeTab === 'backup') {
    bodyHtml = renderBackupTab(ctx, items.length, history.length, totalBlocks);
  } else {
    bodyHtml = renderShelfTab(ctx, items, defaultTarget);
  }

  return {
    html: headerHtml + subTabsHtml + bodyHtml,
    counts: {
      items: items.length,
      history: history.length,
      blocks: totalBlocks,
    },
  };
}
