'use strict';
// V10: Collect only public article links from the creator page. The page's
// 「もっとみる」 button must be clicked; scrolling alone is insufficient.
(() => {
  const RE = /^https:\/\/note\.com\/([a-z0-9_-]+)\/n\/n[a-z0-9]+$/i;
  const MAX_ARTICLES = 500;
  const MAX_MORE_CLICKS = 100;
  const MAX_STEPS = 175;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  let running = false;
  let cancelled = false;
  const canonical = raw => {
    try {
      const u = new URL(raw, location.href);
      const clean = u.origin + u.pathname.replace(/\/+$/, '');
      if (u.protocol !== 'https:' || u.hostname !== 'note.com' || u.username || u.password || u.port) return null;
      return RE.test(clean) ? clean : null;
    } catch { return null; }
  };
  const visible = node => !!node && node.getClientRects().length > 0 && !node.closest?.('[aria-hidden="true"],[inert]');
  const headingFrom = node => {
    if (!node) return '';
    const t = normalize(node.textContent);
    return t.length >= 2 && t.length <= 240 ? t : '';
  };
  function findTitle(anchor) {
    const card = anchor.closest('article,li,[data-testid*="article"],[class*="noteItem"],[class*="NoteItem"]');
    const candidates = [
      anchor.querySelector('h1,h2,h3,h4'),
      card?.querySelector('h1,h2,h3,h4'),
      anchor.closest('h1,h2,h3,h4'),
    ];
    for (const h of candidates) {
      const title = headingFrom(h);
      if (title) return title;
    }
    const texts = [anchor.getAttribute('title'), anchor.getAttribute('aria-label'),
      anchor.innerText, anchor.querySelector('img')?.getAttribute('alt')];
    for (const text of texts) {
      const t = normalize(text);
      if (t.length >= 2 && t.length <= 180 && !/^#/.test(t)) return t;
    }
    return '';
  }
  function readLinks(owner, records) {
    for (const a of document.querySelectorAll('a[href*="/n/"]')) {
      const url = canonical(a.href);
      if (!url || url.match(RE)[1].toLowerCase() !== owner || !visible(a)) continue;
      const title = findTitle(a);
      if (!records.has(url) || (!records.get(url) && title)) records.set(url, title);
    }
  }
  function correctPage(owner) {
    if (location.origin !== 'https://note.com') return false;
    return location.pathname.split('/')[1]?.toLowerCase() === owner;
  }
  const isMoreText = text => {
    const t = normalize(text).replace(/\s+/g, '');
    return ['もっとみる','もっと見る','記事をもっと見る','さらに表示','もっと表示'].includes(t);
  };
  const safeControl = el => {
    if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (el.closest('[role="dialog"],[role="menu"],header,nav')) return false;
    if (el.tagName.toLowerCase() === 'a') {
      // Only click same-document actions; do not follow URLs away from the collector tab.
      const href = el.getAttribute('href');
      if (href && href !== '#') {
        try {
          const u = new URL(href, location.href);
          if (u.origin !== location.origin || u.pathname !== location.pathname || u.search !== location.search) return false;
        } catch { return false; }
      }
    }
    return true;
  };
  function findMoreButton() {
    // Priority 1: native/accessible button or same-document link.
    const selectors = 'button,[role="button"],a,[tabindex]';
    const candidates = [...document.querySelectorAll(selectors)]
      .filter(el => safeControl(el) && isMoreText(el.innerText || el.textContent || el.getAttribute('aria-label')));
    if (candidates.length) return candidates.at(-1);

    // Priority 2: note may render a clickable wrapper around a <span>.
    // Only use compact controls whose entire label is precisely 「もっとみる」.
    const leaves = [...document.querySelectorAll('span,div')].filter(el => {
      if (!visible(el) || !isMoreText(el.innerText || el.textContent)) return false;
      return ![...el.children].some(ch => isMoreText(ch.innerText || ch.textContent));
    });
    for (const leaf of leaves.reverse()) {
      let el = leaf;
      for (let i = 0; i < 3 && el; i++, el = el.parentElement) {
        if (!safeControl(el)) continue;
        const style = window.getComputedStyle?.(el);
        if (el.tagName.toLowerCase() === 'button' || el.getAttribute('role') === 'button' ||
            el.hasAttribute('onclick') || style?.cursor === 'pointer') return el;
      }
    }
    return null;
  }
  function hasMoreLabel() {
    // Detect an unrecognised button without mistakenly claiming collection finished.
    return [...document.querySelectorAll('button,[role="button"],a,span')]
      .some(el => visible(el) && isMoreText(el.innerText || el.textContent || el.getAttribute('aria-label')));
  }
  async function progress(count, clicks) {
    try { await chrome.runtime.sendMessage({type:'NOTE_COLLECT_PROGRESS', count, clicks}); } catch {}
  }
  function result(rows, clicks, complete, warning = '') {
    return {records:[...rows].slice(0,MAX_ARTICLES).map(([url,title])=>({url,title})),clicks,complete,warning};
  }
  async function collect(owner) {
    if (!correctPage(owner)) throw Error('指定した note ID のページではありません。');
    const rows = new Map();
    let idle = 0;
    let clicks = 0;
    let lastHeight = 0;
    await sleep(700);
    for (let step = 0; step < MAX_STEPS; step++) {
      if (cancelled) throw Error('収集を停止しました。');
      if (!correctPage(owner)) return result(rows,clicks,false,'収集中に別のページへ移動しました。');
      const oldCount = rows.size;
      readLinks(owner,rows);
      window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'});
      await sleep(550);
      readLinks(owner,rows);
      await progress(rows.size,clicks);
      if (rows.size >= MAX_ARTICLES)
        return result(rows,clicks,false,`最大${MAX_ARTICLES}件に達しました。これより古い記事がある場合は未取得です。`);

      const more = findMoreButton();
      if (more) {
        if (clicks >= MAX_MORE_CLICKS)
          return result(rows,clicks,false,`「もっとみる」の操作が${MAX_MORE_CLICKS}回に達したため停止しました。`);
        const beforeClick = rows.size;
        more.scrollIntoView({block:'center',behavior:'instant'});
        await sleep(180);
        if (cancelled) throw Error('収集を停止しました。');
        try { more.click(); } catch {
          return result(rows,clicks,false,'「もっとみる」をクリックできませんでした。');
        }
        clicks++;
        let loaded = false;
        for (let wait = 0; wait < 26; wait++) {
          if (cancelled) throw Error('収集を停止しました。');
          await sleep(500);
          readLinks(owner,rows);
          if (rows.size > beforeClick) { loaded = true; break; }
        }
        await progress(rows.size,clicks);
        if (!loaded)
          return result(rows,clicks,false,'「もっとみる」を押しましたが、13秒以内に新しい記事を確認できませんでした。追加分が残っている可能性があります。');
        idle = 0;
        lastHeight = 0;
        continue;
      }
      const height = document.documentElement.scrollHeight;
      if (rows.size === oldCount && height === lastHeight) idle++;
      else idle = 0;
      lastHeight = height;
      if (idle >= 5) {
        if (findMoreButton() || hasMoreLabel()) {
          return result(rows,clicks,false,'「もっとみる」が残っていますが、追加記事を読み込めません。');
        }
        return result(rows,clicks,true);
      }
    }
    return result(rows,clicks,false,'収集処理の安全上限に達しました。続きを取得できていない可能性があります。');
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'NOTE_COLLECT_STOP') { cancelled = true; respond({ok:true}); return; }
    if (message?.type !== 'NOTE_COLLECT') return;
    if (running) { respond({ok:false,error:'このタブではすでに収集しています。'}); return; }
    const owner = String(message.owner || '').toLowerCase();
    if (!/^[a-z0-9_-]{1,80}$/.test(owner) || !correctPage(owner)) {
      respond({ok:false,error:'指定したクリエイターページを開けません。'}); return;
    }
    running = true;
    cancelled = false;
    respond({ok:true});
    (async()=>{
      try {
        const {records,clicks,complete,warning} = await collect(owner);
        await chrome.runtime.sendMessage({type:'NOTE_COLLECT_DONE',owner,records,clicks,complete,warning});
      } catch (error) {
        try { await chrome.runtime.sendMessage({type:'NOTE_COLLECT_FAILED',owner,error:String(error?.message||error).slice(0,300)}); } catch {}
      } finally { running = false; }
    })();
  });
})();
