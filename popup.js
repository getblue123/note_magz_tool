'use strict';
const $=id=>document.getElementById(id);
const ARTICLE_RE=/^https:\/\/note\.com\/([a-z0-9_-]+)\/n\/n[a-z0-9]+$/i;
let selectedUrls=[], fileData=null, fileMeta=null, statusMemory=null;
function canonical(raw){
  try {
    const u=new URL(String(raw||'').trim());
    if(u.protocol!=='https:'||u.hostname!=='note.com'||u.port||u.username||u.password)return null;
    const normal=u.origin+u.pathname.replace(/\/+$/,'');
    return ARTICLE_RE.test(normal)?normal:null;
  }catch{return null;}
}
function authorOf(url){return canonical(url)?.match(ARTICLE_RE)?.[1]?.toLowerCase()||null;}
function scopeKey(author,magazine){return `owner:${author}\nmagazine:${magazine}`;}
function parseCsv(text){
  const out=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){
      if(quoted&&text[i+1]==='"'){field+='"';i++;} else quoted=!quoted;
    }else if(c===','&&!quoted){row.push(field);field='';}
    else if((c==='\r'||c==='\n')&&!quoted){
      if(c==='\r'&&text[i+1]==='\n')i++;
      row.push(field);if(row.some(s=>s.trim()))out.push(row);
      row=[];field='';
    }else field+=c;
  }
  if(quoted)throw Error('CSV の引用符が正しくありません。UTF-8 で保存し直してください。');
  row.push(field);if(row.some(s=>s.trim()))out.push(row);
  return out;
}
function headerIndex(headers,names){return headers.findIndex(x=>names.includes(x.toLowerCase().replace(/\s+/g,'')));}
function chapterInfo(title){
  const t=String(title||'').normalize('NFKC');
  // Series-independent numbering: 第1話 / 1話 / Episode 12 / 『作品名』12. / 1. at the start.
  const patterns=[
    /第\s*(\d{1,5})\s*(?:話|章|回|節|編)/i,
    /(?:^|[\s「『【\[(（])\s*(\d{1,5})\s*(?:話|章|回|節|編)/i,
    /(?:chapter|episode|ep\.?|part|第)\s*#?\s*(\d{1,5})(?=\b|\s|[\u3000.,:：話章])/i,
    /(?:^|[』」】\])）\s])\s*(\d{1,5})\s*[.．。:：](?!\d)/,
    /^\s*(\d{1,5})\s*[.．。:：](?!\d)/
  ];
  const hit=patterns.map(re=>t.match(re)).find(Boolean);
  if(!hit)return null;
  const number=Number(hit[1]);if(!Number.isInteger(number)||number<1)return null;
  const before=/前編|前篇|上編|上巻|前半|\bpart\s*[1Ⅰ]/i.test(t);
  const after=/後編|後篇|下編|下巻|後半|\bpart\s*[2Ⅱ]/i.test(t);
  return {number,part:before&&!after?0:after&&!before?2:1};
}
function parseSelection(text,filename,order){
  text=text.replace(/^\uFEFF/,'');
  let items=[];const csv=filename.toLowerCase().endsWith('.csv');
  if(csv){
    const rows=parseCsv(text);if(!rows.length)throw Error('CSV が空です。');
    const heads=rows[0].map(s=>s.trim());
    const urlCol=headerIndex(heads,['記事url','記事のurl','記事網址','文章網址','url','リンク','記事リンク']);
    const titleCol=headerIndex(heads,['記事タイトル','タイトル','文章標題','記事名','title']);
    const flagCol=headerIndex(heads,['追加(y)','加入(y)','選択(y)','対象(y)','選択','対象','add','include']);
    if(urlCol<0)throw Error('「記事URL」列が見つかりません。旧版の「文章網址」列も利用できます。');
    items=rows.slice(1).filter(r=>{
      if(flagCol<0)return true;
      return ['y','yes','1','true','on','はい','追加','加入','✓','✔'].includes((r[flagCol]||'').trim().toLowerCase());
    }).map((r,i)=>({url:r[urlCol]||'',title:titleCol>=0?r[titleCol]||'':'',i}));
  }else{
    items=text.split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'))
      .map((url,i)=>({url,title:'',i}));
  }
  if(items.length>500)throw Error('一度に読み込める記事は最大500件です。');
  if(!items.length)throw Error('対象の記事がありません。選択列がある CSV は Y を入力してください。');
  const invalid=items.filter(item=>!canonical(item.url));
  if(invalid.length)throw Error(`${invalid.length}件のURLが無効です。note.com/ユーザーID/n/n… の形式で入力してください。`);
  const seen=new Set();
  items=items.filter(item=>{
    item.url=canonical(item.url);
    if(seen.has(item.url))return false;
    seen.add(item.url);return true;
  });
  const authors=[...new Set(items.map(item=>authorOf(item.url)))];
  if(authors.length!==1)throw Error(`複数のユーザーの記事が含まれています（${authors.length}人）。安全のため1回のリストは1人分にしてください。`);
  let unknown=0;
  if(order==='chapter'){
    if(!items.some(item=>item.title.trim()))throw Error('話数順に並べるには「記事タイトル」を含む CSV が必要です。TXT はリスト順を選んでください。');
    items.forEach(item=>{item.chapter=chapterInfo(item.title);if(!item.chapter)unknown++;});
    items.sort((a,b)=>{
      if(!a.chapter&&!b.chapter)return a.i-b.i;
      if(!a.chapter)return 1;if(!b.chapter)return -1;
      return a.chapter.number-b.chapter.number||a.chapter.part-b.chapter.part||a.i-b.i;
    });
  }
  const preview=items.slice(0,5).map(x=>`${x.chapter?`第${x.chapter.number}話 `:''}${x.title||x.url}`);
  return {urls:items.map(x=>x.url),sourceId:authors[0],unknown,preview,order,total:items.length};
}
function showPreview(value,error=false){$('preview').textContent=value;$('preview').className=error?'error':'';}
function loadSelection(){
  if(!fileData)return;
  fileMeta=parseSelection(fileData.text,fileData.name,$('order').value);
  selectedUrls=fileMeta.urls;
  showPreview(`対象ユーザー: ${fileMeta.sourceId}\n選択: ${fileMeta.total}件\n実行順（先頭）:\n${fileMeta.preview.join('\n')}${fileMeta.total>5?'\n…':''}${fileMeta.unknown?`\n⚠ 話数を判別できない記事 ${fileMeta.unknown}件は最後に並びます。`:''}`);
}
const send=message=>chrome.runtime.sendMessage(message);
async function refresh(){
  try {
    const response=await send({type:'NOTE_STATUS'});if(!response.ok)throw Error(response.error);
    statusMemory=response;
    const run=response.run,mag=$('magazine').value.trim();
    const list=selectedUrls.length?selectedUrls:response.params.urls||[];
    const sourceId=list.length?authorOf(list[0]):null;
    const key=sourceId&&mag?scopeKey(sourceId,mag):'';
    const legacyOkay=sourceId && response.params.magazine===mag && (response.params.urls||[]).every(u=>authorOf(u)===sourceId);
    const records=response.done[key]||(legacyOkay?response.done[mag]:null)||{};
    const count=list.filter(url=>['added','already'].includes(records[url]?.status)).length;
    const desc=run?.active?`実行中: ${run.message}\n今回の確認済み ${run.index}/${run.queue.length}件`:
      `${run?.message||'未開始'}${list.length&&mag?`\n完了記録 ${count}/${list.length}件`:''}`;
    $('status').textContent=desc;
    $('test').disabled=!!run?.active||!list.length||!mag;
    $('all').disabled=!!run?.active||!list.length||!mag||count<3;
    $('stop').disabled=!run?.active;
    if(!selectedUrls.length&&response.params.urls?.length&&!fileData){
      showPreview(`前回のリスト: ${response.params.urls.length}件（${authorOf(response.params.urls[0])}）。\n順序変更には CSV を再読み込みしてください。`);
    }
  }catch(err){$('status').textContent='状態の取得に失敗: '+err.message;}
}
$('file').addEventListener('change',async e=>{
  const file=e.target.files?.[0];if(!file)return;
  try {fileData={text:await file.text(),name:file.name};loadSelection();}
  catch(err){selectedUrls=[];fileMeta=null;showPreview(err.message,true);}
  await refresh();
});
$('order').addEventListener('change',async()=>{
  if(fileData){try{loadSelection();}catch(err){selectedUrls=[];fileMeta=null;showPreview(err.message,true);}}
  await refresh();
});
$('magazine').addEventListener('input',refresh);
async function start(mode){
  const magazine=$('magazine').value.trim();
  const old=statusMemory?.params||{};
  const urls=selectedUrls.length?selectedUrls:old.urls||[];
  const orderMode=selectedUrls.length?$('order').value:old.orderMode||'list';
  if(!magazine||!urls.length){$('status').textContent='記事リストとマガジン名を入力してください。';return;}
  if(!selectedUrls.length&&old.orderMode!==$('order').value){
    alert('処理順序を変更する場合は CSV を再読み込みしてください。');return;
  }
  const sourceId=authorOf(urls[0]);
  const first=fileMeta?.preview?.slice(0,3).join('\n')||urls.slice(0,3).join('\n');
  const unknown=fileMeta?.unknown?`\n注意: 話数未判別 ${fileMeta.unknown}件`:'';
  const message=`対象アカウント: ${sourceId}\nマガジン: ${magazine}\n対象: ${urls.length}件\n順序: ${orderMode==='chapter'?'話数が小さい順':'リスト順'}${unknown}\n先頭の記事:\n${first}\n\nnote にログイン済みで、追加先と対象の記事が正しいことを確認しましたか？`;
  if(!confirm(message))return;
  const response=await send({type:'NOTE_START',mode,magazine,urls,orderMode});
  if(!response.ok)alert(response.error);
  await refresh();
}
$('test').addEventListener('click',()=>start('test').catch(err=>alert(err.message)));
$('all').addEventListener('click',()=>start('all').catch(err=>alert(err.message)));
$('stop').addEventListener('click',async()=>{await send({type:'NOTE_STOP'});await refresh();});
const quote=value=>`"${String(value??'').replace(/"/g,'""')}"`;
$('download').addEventListener('click',async()=>{
  const result=await send({type:'NOTE_STATUS'});
  if(!result.ok){alert(result.error);return;}
  const mag=$('magazine').value.trim()||result.params.magazine||'';
  const urls=selectedUrls.length?selectedUrls:result.params.urls||[];
  if(!urls.length){alert('書き出す記事リストがありません。');return;}
  const author=authorOf(urls[0]);const key=scopeKey(author,mag);
  const legacyOkay=result.params.magazine===mag&&(result.params.urls||[]).every(u=>authorOf(u)===author);
  const records=result.done[key]||(legacyOkay?result.done[mag]:null)||{};
  const rows=[['マガジン名','記事URL','状態','詳細','日時'],...urls.map(url=>{
    const rec=records[url]||{};return [mag,url,rec.status||'pending',rec.detail||'',rec.time||''];
  })];
  const csv='\uFEFF'+rows.map(r=>r.map(quote).join(',')).join('\r\n');
  const blobUrl=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  const link=document.createElement('a');link.href=blobUrl;link.download='note_magazine_results.csv';link.click();
  setTimeout(()=>URL.revokeObjectURL(blobUrl),1000);
});
(async()=>{
  try {
    const result=await send({type:'NOTE_STATUS'});
    if(result.ok){if(result.params.magazine)$('magazine').value=result.params.magazine;
      if(result.params.orderMode)$('order').value=result.params.orderMode;}
  }catch{}
  await refresh();setInterval(refresh,1500);
})();

// V9: create the same importable CSV that users previously built with a separate tool.
function parseProfileOwner(raw){
  let text=String(raw||'').trim().replace(/^@/,'');
  if(/^https?:\/\//i.test(text)){
    const u=new URL(text);
    if(u.protocol!=='https:'||u.hostname!=='note.com'||u.port||u.username||u.password)
      throw Error('https://note.com/ユーザーID の形式で入力してください。');
    text=u.pathname.split('/')[1]||'';
  }
  if(!/^[a-z0-9_-]{1,80}$/i.test(text))throw Error('note ID またはプロフィールURLを入力してください。');
  return text.toLowerCase();
}
function safeCsvValue(value){
  const t=String(value??'').replace(/[\x00-\x1f\x7f]/g,' ').trim();
  // Article titles are untrusted web text. Prevent formula execution in spreadsheet apps.
  return /^[=+\-@]/.test(t)?"'"+t:t;
}
function saveTextFile(filename,content){
  const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=filename;
  document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
}
let collectionStatus=null;
async function refreshCollector(){
  try{
    const response=await send({type:'NOTE_COLLECT_STATUS'});
    if(!response.ok)throw Error(response.error);
    const c=response.collection;
    collectionStatus=c;
    $('collectStatus').textContent=c
      ?`アカウント: ${c.owner}\n${c.message||''}${c.status==='done'?`\n取得件数: ${c.records.length}件`:''}`
      :'未収集';
    $('collect').disabled=!!c?.active;
    $('collectStop').disabled=!c?.active;
    $('collectDownload').disabled=!c?.records?.length || !!c?.active;
    $('collectStatus').classList.toggle('error',c?.status==='failed');
    $('collectStatus').classList.toggle('partial',c?.status==='partial');
    if(c?.owner && !$('profile').value.trim())$('profile').value=c.owner;
  }catch(err){$('collectStatus').textContent='収集状態を取得できません: '+err.message;}
}
$('collect').addEventListener('click',async()=>{
  try{
    const owner=parseProfileOwner($('profile').value);
    const confirmed=confirm(`アカウント「${owner}」の公開記事を収集します。\n新しく開いた note タブを閉じず、収集完了をお待ちください。\n\n記事の追加や編集は行いません。`);
    if(!confirmed)return;
    const result=await send({type:'NOTE_COLLECT_START',owner});
    if(!result.ok)throw Error(result.error);
    await refreshCollector();
  }catch(err){alert(err.message);}
});
$('collectStop').addEventListener('click',async()=>{
  try{const r=await send({type:'NOTE_COLLECT_STOP_REQUEST'});if(!r.ok)throw Error(r.error);await refreshCollector();}
  catch(err){alert(err.message);}
});
$('collectDownload').addEventListener('click',()=>{
  const c=collectionStatus;
  if(!c?.records?.length||c.active){alert('先に記事を取得してください。');return;}
  if(c.status==='partial'&&!confirm(`収集は未完了です。${c.records.length}件だけをCSVとして保存しますか？\n${c.warning||'続きが残っている可能性があります。'}`))return;
  const fill=$('csvDefault').value==='all'?'Y':'';
  const rows=[['追加(Y)','記事タイトル','記事URL'],...c.records.map(x=>[
    fill,safeCsvValue(x.title||'（タイトル未取得：URLを確認）'),x.url
  ])];
  const csv='\uFEFF'+rows.map(row=>row.map(quote).join(',')).join('\r\n');
  saveTextFile(`note_articles_${c.owner}.csv`,csv);
});
refreshCollector();
setInterval(refreshCollector,1600);
