 'use strict';
// V7: content-side actions use the human-selected action bar as contextual evidence.
// Never uses private APIs or reads passwords/cookies.
let processing = false;
const LEARN_KEY = 'note_add_trigger_v7';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();

function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
}
function controls(root = document) {
  return [...root.querySelectorAll('button,[role="button"],a[role="button"]')].filter(isVisible);
}
function labels(el) {
  const fields = ['aria-label', 'title', 'data-tooltip', 'data-tooltip-content', 'data-original-title'];
  const values = fields.map(k => el.getAttribute(k));
  for (const nested of el.querySelectorAll('[aria-label],[title],svg title')) {
    values.push(nested.getAttribute('aria-label'), nested.getAttribute('title'), nested.textContent);
  }
  const describedBy = el.getAttribute('aria-describedby');
  if (describedBy) for (const id of describedBy.split(/\s+/)) {
    const node = document.getElementById(id);
    if (node) values.push(node.textContent);
  }
  values.push(el.innerText, el.textContent);
  return values.map(norm).filter(Boolean);
}
function buttonText(el) { return labels(el)[0] || ''; }
const isAddTrigger = s => /記事を追加|記事を保存|マガジンに追加/.test(s);
const isMembershipAction = s => /^追加済み?$|^追加$/.test(s);

// SVG path fingerprint, learned from the actual book+ button clicked by the user.
// Do not guess by nth button or screen coordinates; layouts differ among articles.
function fingerprint(el) {
  const svg = el.querySelector('svg');
  if (!svg) return '';
  const shapes = [...svg.querySelectorAll('path,rect,circle,line,polyline,polygon,ellipse')];
  const bits = shapes.map(shape => {
    const keys = ['d', 'points', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height'];
    return `${shape.tagName.toLowerCase()}:` + keys.map(k => shape.getAttribute(k) || '').join('|');
  });
  return bits.length ? bits.join('||') : '';
}
function candidatesForFingerprint(fp) {
  return fp ? controls().filter(el => fingerprint(el) === fp) : [];
}
// A book+ icon alone is NOT unique on note: recommended articles can reuse the
// exact same SVG dozens of times. Only use it automatically when the
// surrounding action toolbar (like, reply, share, etc.) identifies a unique row.
function actionGroup(el) {
  let parent = el.parentElement;
  for (let depth = 0; depth < 10 && parent && parent !== document.body; depth++, parent = parent.parentElement) {
    const members = controls(parent);
    if (members.length < 4 || members.length > 9 || !members.includes(el)) continue;
    const icons = members.map(fingerprint);
    const i = members.indexOf(el);
    const otherIcons = icons.filter((fp, idx) => idx !== i && fp);
    if (otherIcons.length < 3 || new Set(otherIcons).size < 2) continue;
    return {kind:'group', index:i, icons};
  }
  return null;
}
function actionRow(el) {
  // When a page wraps toolbar buttons in separate divs, identify their
  // horizontal row by bounding rectangles instead of CSS class names.
  const r = el.getBoundingClientRect();
  const mid = r.top + r.height / 2;
  const x = r.left + r.width / 2;
  const peers = controls().filter(other => {
    if (other.closest('[data-w-note-guide]')) return false;
    const o=other.getBoundingClientRect();
    return o.width > 0 && o.height > 0 && Math.abs(o.top + o.height/2 - mid) <= 15 &&
      Math.abs(o.left + o.width/2 - x) <= 250;
  }).sort((a,b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  if (peers.length < 4 || peers.length > 9 || !peers.includes(el)) return null;
  const icons=peers.map(fingerprint);
  const i=peers.indexOf(el);
  const otherIcons=icons.filter((fp,idx)=>idx!==i&&fp);
  if (otherIcons.length < 3 || new Set(otherIcons).size < 2) return null;
  return {kind:'row',index:i,icons};
}
function actionContext(el) { return actionGroup(el) || actionRow(el); }
function contextScore(actual, expected) {
  if (!actual || !expected || actual.kind !== expected.kind || actual.index !== expected.index ||
      actual.icons.length !== expected.icons.length) return -1;
  let same=0;
  for(let i=0;i<expected.icons.length;i++) {
    if(i!==expected.index && expected.icons[i] && actual.icons[i]===expected.icons[i]) same++;
  }
  return same;
}
function findLearnedTrigger(learned) {
  const matches = candidatesForFingerprint(learned?.fingerprint);
  if (matches.length===1) return matches[0];
  if (!learned?.context || !matches.length) return null;
  // Prefer a complete action-bar match, but allow a single icon elsewhere in
  // the bar to change (for example a filled like heart) when unique.
  const required = Math.max(2, learned.context.icons.filter(Boolean).length - 2);
  const ranked=matches.map(el=>({el, score:contextScore(actionContext(el),learned.context)}));
  const qualified=ranked.filter(x=>x.score>=required);
  return qualified.length===1 ? qualified[0].el : null;
}
async function waitFor(fn, timeout = 10000, interval = 250) {
  const deadline = Date.now() + timeout;
  do {
    const result = fn();
    if (result) return result;
    await delay(interval);
  } while (Date.now() < deadline);
  return null;
}
async function findAddTrigger() {
  const learned = (await chrome.storage.local.get(LEARN_KEY))[LEARN_KEY];
  if (learned?.fingerprint) {
    const matched = findLearnedTrigger(learned);
    if (matched) return matched;
  }
  // Labels are more trustworthy than SVGs. Never pick the first from
  // several matches, since that can add the wrong article or magazine.
  const named = controls().filter(el => labels(el).some(isAddTrigger));
  return named.length === 1 ? named[0] : null;
}
function actionState(el) {
  const strs = labels(el);
  if (strs.some(s => /^追加済み?$/.test(s))) return '追加済';
  if (strs.some(s => s === '追加')) return '追加';
  return null;
}
function chooseMagazine(magazine) {
  // Only match the exact target name in a leaf node; do not choose the first magazine.
  const nameNodes = [...document.querySelectorAll('span,p,div,strong,h2,h3,h4,li,label')]
    .filter(el => isVisible(el) && norm(el.textContent) === magazine &&
      ![...el.children].some(c => norm(c.textContent) === magazine));
  const buttons = [];
  for (const nameNode of nameNodes) {
    let parent = nameNode;
    for (let depth = 0; depth < 8 && parent; depth++, parent = parent.parentElement) {
      const matches = controls(parent).filter(el => actionState(el));
      if (matches.length === 1) { buttons.push(matches[0]); break; }
    }
  }
  const distinct = [...new Set(buttons)];
  if (distinct.length > 1) throw Error('同じ名前のマガジンが複数見つかったため、安全のため停止しました。');
  if (distinct.length === 1) return {button:distinct[0], state:actionState(distinct[0])};
  return null;
}

function box(tag, text, styles={}) {
  const el = document.createElement(tag);
  el.textContent=text;
  Object.assign(el.style, styles);
  return el;
}
async function manualCalibration() {
  // Wait for a single guided user click; intercept before note receives the click.
  // Confirm and learn only the icon's geometry, NOT a password/cookie/DOM snapshot.
  return new Promise((resolve, reject) => {
    const panel = document.createElement('div');
    panel.setAttribute('data-w-note-guide', 'true');
    Object.assign(panel.style, {
      position:'fixed', zIndex:'2147483647', right:'18px', bottom:'20px',
      width:'330px', padding:'16px', background:'#fff', color:'#18202b',
      border:'2px solid #16805b', borderRadius:'12px', boxShadow:'0 8px 32px #0004',
      font:'14px/1.5 system-ui,sans-serif', boxSizing:'border-box'
    });
    panel.append(box('div', '「記事を追加」ボタンを確認してください', {fontWeight:'700',fontSize:'16px'}));
    panel.append(box('p', '記事本文の下、スキやコメントの隣にある「本＋」ボタンをクリックしてください。位置の指定だけを行い、まだマガジンには追加しません。', {margin:'8px 0'}));
    const msg=box('div', '「本＋」ボタンの選択を待っています…', {color:'#576070',fontSize:'12px',marginBottom:'10px'});
    panel.append(msg);
    const row=document.createElement('div');
    Object.assign(row.style, {display:'flex',gap:'8px'});
    const confirm=box('button','このボタンで確定');
    const cancel=box('button','キャンセル');
    for (const btn of [confirm,cancel]) Object.assign(btn.style, {
      border:0, borderRadius:'7px', padding:'8px 11px', cursor:'pointer', fontWeight:'600'
    });
    Object.assign(confirm.style, {background:'#16805b',color:'#fff',display:'none'});
    Object.assign(cancel.style, {background:'#e8edf1',color:'#222'});
    row.append(confirm,cancel); panel.append(row); document.body.append(panel);
    let selected=null, previousOutline='';
    const restore=()=>{if(selected?.isConnected) selected.style.outline=previousOutline;};
    const cleanup=()=>{document.removeEventListener('click', capture, true);restore();panel.remove();};
    function capture(e) {
      if (panel.contains(e.target)) return;
      const target=e.target instanceof Element ? e.target.closest('button,[role="button"],a[role="button"]') : null;
      if (!target || !isVisible(target)) return;
      // Protect user from accidental actions while in calibration mode.
      e.preventDefault();e.stopImmediatePropagation();
      restore(); selected=target; previousOutline=selected.style.outline;
      selected.style.outline='3px solid #16805b';
      if (!fingerprint(selected)) {
        msg.textContent='このボタンのアイコンを識別できません。「本＋」ボタンを選んでください。';
        confirm.style.display='none'; return;
      }
      msg.textContent='選択したボタンを緑色の枠で囲みました。記事本文の下にある「本＋」か確認してください。同じアイコンがほかの場所にあっても、今回の選択を妨げません。';
      confirm.style.display='inline-block';
    }
    document.addEventListener('click', capture, true);
    confirm.addEventListener('click', async()=>{
      if (!selected) return;
      const fp=fingerprint(selected);
      const context=actionContext(selected);
      // The user selected the correct control directly. Duplicates elsewhere
      // must NOT reject this one-time, human-confirmed button.
      // For later articles, auto-selection still requires a unique match.
      confirm.disabled=true;
      try {
        await chrome.storage.local.set({[LEARN_KEY]:{
          fingerprint:fp, context, learnedAt:new Date().toISOString()
        }});
        const target=selected;
        cleanup(); resolve(target);
      } catch(e) {cleanup();reject(e);}
    });
    cancel.addEventListener('click',()=>{cleanup();reject(Error('ボタンの指定をキャンセルしました。記事には変更を加えていません。'));});
  });
}
async function ensureRunStillActive() {
  const state=await chrome.runtime.sendMessage({type:'NOTE_STATUS'});
  if(!state?.ok || !state.run?.active) throw Error('処理は停止しました。これ以上操作しません。');
}
async function processArticle(url, magazine) {
  const current=new URL(location.href);
  if (current.origin!=='https://note.com' || `${current.origin}${current.pathname.replace(/\/+$/,'')}`!==url)
    throw Error('現在のページはリストで指定した記事ではありません。操作を停止しました。');
  // Give hydration time; some buttons appear after page load.
  let trigger=null;
  for(let i=0;i<20 && !trigger;i++) {
    trigger=await findAddTrigger();
    if(!trigger) await delay(350);
  }
  if (!trigger) {
    // Scroll down to article footer; this can reveal controls with lazy rendering.
    window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'});
    await delay(900);
    for(let i=0;i<12 && !trigger;i++) {
      trigger=await findAddTrigger();
      if(!trigger) await delay(350);
    }
  }
  if (!trigger) trigger=await manualCalibration();
  await ensureRunStillActive();
  if (!isVisible(trigger)) throw Error('選択したボタンが見つからなくなりました。処理を停止しました。');
  trigger.scrollIntoView({block:'center'});
  await delay(250);
  trigger.click();
  const found=await waitFor(()=>chooseMagazine(magazine),12000);
  if(!found) throw Error(`「記事を追加」をクリックしましたが、マガジン「${magazine}」の「追加」ボタンが見つかりません。表示内容を確認してください。`);
  if(found.state==='追加済') return {status:'already',detail:'画面に「追加済」と表示されています。操作を省略しました。'};
  if(found.state!=='追加') throw Error('追加の状態を確認できなかったため停止しました。');
  await ensureRunStillActive();
  found.button.click();
  const confirmed=await waitFor(()=>{
    const result=chooseMagazine(magazine);
    return result?.state==='追加済' ? true : null;
  },10000);
  if(confirmed) return {status:'added',detail:'追加後、画面上で「追加済」を確認しました。'};
  // We never click twice without a new human inspection: the button may be a toggle.
  return {status:'needs_review',detail:'「追加」を一度クリックしましたが「追加済」を確認できませんでした。重複クリックせず、マガジンを確認してください。'};
}
chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
  if(message?.type!=='NOTE_PROCESS') return;
  if(processing){reply({ok:false,error:'このページは処理中です'});return;}
  processing=true;
  reply({ok:true});
  (async()=>{
    let result;
    try {result=await processArticle(message.url,message.magazine);}
    catch(e){result={status:'failed',detail:String(e?.message||e).slice(0,500)};}
    try {await chrome.runtime.sendMessage({type:'NOTE_RESULT',url:message.url,...result});}
    catch(e){console.warn('note の処理結果を送信できませんでした',e);}
    processing=false;
  })();
});
