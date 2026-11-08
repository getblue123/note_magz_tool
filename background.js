'use strict';
// 追加操作はログイン済み note.com の画面上で行う。非公開 API・Cookie・パスワードは扱わない。
// Storage keys are unchanged for in-place upgrades from earlier releases.
const RUN_KEY='note_run_v4';
const DONE_KEY='note_done_v4';
const PARAMS_KEY='note_params_v4';
const COLLECT_KEY='note_collect_v9';
const collectorDispatching=new Set();
const ARTICLE_RE=/^https:\/\/note\.com\/([a-z0-9_-]+)\/n\/n[a-z0-9]+$/i;
function canonical(raw){
  try{
    const u=new URL(String(raw||'').trim());
    if(u.protocol!=='https:'||u.hostname!=='note.com'||u.port||u.username||u.password)return null;
    const result=u.origin+u.pathname.replace(/\/+$/,'');
    return ARTICLE_RE.test(result)?result:null;
  }catch{return null;}
}
const authorOf=url=>canonical(url)?.match(ARTICLE_RE)?.[1]?.toLowerCase()||null;
const scopeKey=(author,magazine)=>`owner:${author}\nmagazine:${magazine}`;
const now=()=>new Date().toISOString();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const getState=()=>chrome.storage.local.get([RUN_KEY,DONE_KEY,PARAMS_KEY]);
async function status(){
  const state=await getState();
  return {run:state[RUN_KEY]||null,done:state[DONE_KEY]||{},params:state[PARAMS_KEY]||{}};
}
function previousRecords(state,author,magazine){
  const all=state[DONE_KEY]||{};
  const key=scopeKey(author,magazine);
  if(all[key])return {...all[key]};
  const old=state[PARAMS_KEY]||{};
  const oldUrls=old.urls||[];
  // Migrate only if the old list demonstrably belongs to this same account.
  if(old.magazine===magazine&&oldUrls.length&&oldUrls.every(u=>authorOf(u)===author)&&all[magazine]){
    return {...all[magazine]};
  }
  return {};
}
async function start(message){
  const state=await getState();
  if(state[RUN_KEY]?.active)throw Error('処理中の一括操作があります。先に停止してください。');
  const magazine=String(message.magazine||'').trim();
  if(!magazine||magazine.length>180)throw Error('マガジン名は1～180文字で入力してください。');
  const input=Array.isArray(message.urls)?message.urls:[];
  if(!input.length||input.length>500)throw Error('対象記事は1～500件にしてください。');
  const normalized=input.map(canonical);
  if(normalized.some(x=>!x))throw Error('無効な記事URLがあります。note.com/ユーザーID/n/n… の形式にしてください。');
  const urls=[...new Set(normalized)];
  const sourceId=authorOf(urls[0]);
  if(!urls.every(u=>authorOf(u)===sourceId))throw Error('異なるユーザーの記事は同時に処理できません。リストを分けてください。');
  const done=previousRecords(state,sourceId,magazine);
  const pending=urls.filter(u=>!['added','already','needs_review'].includes(done[u]?.status));
  const verified=urls.filter(u=>['added','already'].includes(done[u]?.status)).length;
  const mode=message.mode==='all'?'all':'test';
  if(mode==='all'&&verified<3&&pending.length>3)throw Error('まず3件をテストし、マガジン内の結果を確認してください。');
  if(!pending.length)throw Error('再実行できる記事がありません。「要確認」の記事は結果CSVから手動確認してください。');
  const queue=pending.slice(0,mode==='test'?3:pending.length);
  const tab=await chrome.tabs.create({url:queue[0],active:true});
  const run={active:true,status:'loading',magazine,sourceId,urls,queue,index:0,tabId:tab.id,
    startedAt:now(),updatedAt:now(),mode,message:'最初の記事を開いています…'};
  const allDone=state[DONE_KEY]||{};
  allDone[scopeKey(sourceId,magazine)]=done;
  await chrome.storage.local.set({[RUN_KEY]:run,[DONE_KEY]:allDone,
    [PARAMS_KEY]:{magazine,sourceId,urls,orderMode:message.orderMode==='chapter'?'chapter':'list'}});
  void dispatchIfReady(tab.id);
  return {message:`${mode==='test'?'テスト':'一括追加'}を開始しました（${queue.length}件）。`};
}
async function dispatchIfReady(tabId){
  const state=await chrome.storage.local.get(RUN_KEY);
  const run=state[RUN_KEY];
  if(!run?.active||run.tabId!==tabId||run.status!=='loading')return;
  const expected=run.queue[run.index];if(!expected)return;
  let tab;
  try{tab=await chrome.tabs.get(tabId);}catch{return;}
  if(tab.status!=='complete'||canonical(tab.url)!==expected)return;
  run.status='working';run.updatedAt=now();run.message=`${run.index+1}/${run.queue.length} 件目を処理しています`;
  await chrome.storage.local.set({[RUN_KEY]:run});
  try{await chrome.tabs.sendMessage(tabId,{type:'NOTE_PROCESS',url:expected,magazine:run.magazine});}
  catch(err){
    run.active=false;run.status='paused';run.message='記事ページに拡張機能を接続できません。ページを再読み込みするか、拡張機能が有効か確認してください。';
    run.updatedAt=now();await chrome.storage.local.set({[RUN_KEY]:run});
  }
}
// CSV list collection happens on the public creator page in a normal Chrome tab.
// The author ID is not fixed; every collection run validates its creator and URL.
function parseOwner(input){
  const raw=String(input||'').trim().replace(/^@/, '');
  let owner=raw;
  if(/^https?:\/\//i.test(raw)){
    const url=new URL(raw);
    if(url.protocol!=='https:'||url.hostname!=='note.com'||url.port||url.username||url.password)throw Error('https://note.com/ユーザーID の形式で入力してください。');
    owner=url.pathname.split('/')[1]||'';
  }
  if(!/^[a-z0-9_-]{1,80}$/i.test(owner))throw Error('有効な note ID またはプロフィールURLを入力してください。');
  return owner.toLowerCase();
}
async function startCollect(message){
  const state=await chrome.storage.local.get([COLLECT_KEY,RUN_KEY]);
  if(state[RUN_KEY]?.active)throw Error('マガジンへの追加を実行中です。終了してから収集してください。');
  if(state[COLLECT_KEY]?.active)throw Error('記事の収集中です。停止または完了を待ってください。');
  const owner=parseOwner(message.owner);
  const tab=await chrome.tabs.create({url:`https://note.com/${owner}/all`,active:true});
  const collecting={active:true,owner,tabId:tab.id,status:'loading',count:0,clicks:0,complete:false,warning:'',
    records:[],message:'記事一覧を開いています…',updatedAt:now()};
  await chrome.storage.local.set({[COLLECT_KEY]:collecting});
  void dispatchCollectorIfReady(tab.id);
  return {message:`${owner} の公開記事一覧を開きました。`};
}
async function dispatchCollectorIfReady(tabId){
  if(collectorDispatching.has(tabId))return;
  collectorDispatching.add(tabId);
  try{
    const state=await chrome.storage.local.get(COLLECT_KEY);
    const c=state[COLLECT_KEY];
    if(!c?.active||c.tabId!==tabId||c.status!=='loading')return;
    let tab;
    try{tab=await chrome.tabs.get(tabId);}catch{return;}
    if(tab.status!=='complete')return;
    try{
      const url=new URL(tab.url);
      if(url.origin!=='https://note.com'||url.pathname.split('/')[1]?.toLowerCase()!==c.owner)
        throw Error('クリエイターページに移動できませんでした。');
      c.status='collecting';c.message='公開記事を読み取っています…';c.updatedAt=now();
      await chrome.storage.local.set({[COLLECT_KEY]:c});
      const response=await chrome.tabs.sendMessage(tabId,{type:'NOTE_COLLECT',owner:c.owner});
      if(!response?.ok)throw Error(response?.error||'収集スクリプトを起動できません。');
    }catch(err){
      const latest=(await chrome.storage.local.get(COLLECT_KEY))[COLLECT_KEY];
      if(latest?.active&&latest.tabId===tabId){
        latest.active=false;latest.status='failed';latest.message=String(err.message||err);latest.updatedAt=now();
        await chrome.storage.local.set({[COLLECT_KEY]:latest});
      }
    }
  }finally{collectorDispatching.delete(tabId);}
}
async function collectFeedback(sender,message){
  const c=(await chrome.storage.local.get(COLLECT_KEY))[COLLECT_KEY];
  if(!c?.active||sender.tab?.id!==c.tabId)return {accepted:false};
  if(message.type==='NOTE_COLLECT_PROGRESS'){
    c.count=Math.max(0,Math.min(500,Number(message.count)||0));
    c.clicks=Math.max(0,Math.min(100,Number(message.clicks)||0));
    c.message=`公開記事を収集中：${c.count}件（「もっとみる」${c.clicks}回）`;c.updatedAt=now();
  }else if(message.type==='NOTE_COLLECT_FAILED'){
    c.active=false;c.status='failed';c.message=`収集できませんでした：${String(message.error||'不明なエラー').slice(0,300)}`;c.updatedAt=now();
  }else if(message.type==='NOTE_COLLECT_DONE'){
    if(message.owner!==c.owner)throw Error('収集元が一致しません。');
    const input=Array.isArray(message.records)?message.records:[];
    const seen=new Set();const rows=[];
    for(const item of input.slice(0,500)){
      const url=canonical(item?.url);
      if(!url||authorOf(url)!==c.owner||seen.has(url))continue;
      seen.add(url);rows.push({url,title:String(item.title||'').replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,240)});
    }
    c.records=rows;c.count=rows.length;c.active=false;
    c.clicks=Math.max(0,Math.min(100,Number(message.clicks)||0));
    c.complete=message.complete===true;
    c.warning=String(message.warning||'').slice(0,400);
    c.status=!rows.length?'failed':c.complete?'done':'partial';
    c.message=!rows.length
      ?'記事が見つかりませんでした。プロフィールが公開されているか、一覧ページの表示を確認してください。'
      :c.complete
        ?`${rows.length}件を取得しました（「もっとみる」${c.clicks}回）。CSVを保存できます。`
        :`⚠ ${rows.length}件を取得しましたが、収集は未完了です。${c.warning||'追加記事が残っている可能性があります。'}
現在の取得分だけCSVとして保存できます。`;
    c.updatedAt=now();
  }
  await chrome.storage.local.set({[COLLECT_KEY]:c});
  return {accepted:true};
}
async function stopCollect(){
  const c=(await chrome.storage.local.get(COLLECT_KEY))[COLLECT_KEY];
  if(!c?.active)return {stopped:false};
  c.active=false;c.status='stopped';c.message='収集を停止しました。';c.updatedAt=now();
  await chrome.storage.local.set({[COLLECT_KEY]:c});
  try{await chrome.tabs.sendMessage(c.tabId,{type:'NOTE_COLLECT_STOP'});}catch{}
  return {stopped:true};
}

// Never resume a half-finished run automatically after an extension upgrade.
chrome.runtime.onInstalled.addListener(async details=>{
  if(details.reason!=='update')return;
  const state=await chrome.storage.local.get(RUN_KEY);const run=state[RUN_KEY];
  const collect=(await chrome.storage.local.get(COLLECT_KEY))[COLLECT_KEY];
  if(collect?.active){collect.active=false;collect.status='stopped';collect.message='拡張機能の更新により収集を停止しました。';await chrome.storage.local.set({[COLLECT_KEY]:collect});}
  if(run){
    const interrupted=!!run.active;
    if(interrupted){run.active=false;run.status='paused';}
    run.updatedAt=now();
    run.message=interrupted
      ? '拡張機能の更新後、安全のため一括操作を停止しました。記事の追加状態を確認してください。'
      : '新版に更新しました。以前の処理履歴は結果CSVから確認できます。';
    await chrome.storage.local.set({[RUN_KEY]:run});
  }
});
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.status==='complete'){void dispatchIfReady(tabId);void dispatchCollectorIfReady(tabId);}});
chrome.tabs.onRemoved.addListener(async tabId=>{
  const collector=(await chrome.storage.local.get(COLLECT_KEY))[COLLECT_KEY];
  if(collector?.active&&collector.tabId===tabId){collector.active=false;collector.status='stopped';collector.message='収集用タブが閉じられました。';collector.updatedAt=now();await chrome.storage.local.set({[COLLECT_KEY]:collector});}
  const state=await chrome.storage.local.get(RUN_KEY);const run=state[RUN_KEY];
  if(run?.active&&run.tabId===tabId){
    run.active=false;run.status='paused';run.message='処理用タブが閉じられたため停止しました。';run.updatedAt=now();
    await chrome.storage.local.set({[RUN_KEY]:run});
  }
});
async function recordResult(sender,message){
  const state=await getState();const run=state[RUN_KEY];
  if(!run?.active||run.status!=='working'||sender.tab?.id!==run.tabId)return {accepted:false};
  const url=run.queue[run.index];
  if(url!==canonical(message.url))return {accepted:false};
  const result=['added','already','failed','needs_review'].includes(message.status)?message.status:'failed';
  const allDone=state[DONE_KEY]||{};
  const key=scopeKey(run.sourceId,run.magazine);
  const done={...(allDone[key]||{})};
  done[url]={status:result,detail:String(message.detail||'').slice(0,500),time:now()};
  allDone[key]=done;run.updatedAt=now();
  if(['added','already'].includes(result)){
    run.index++;
    if(run.index>=run.queue.length){run.active=false;run.status='done';run.message=`今回の${run.queue.length}件を処理しました。マガジンで内容を確認してください。`;}
    else{run.status='loading';run.message=`${run.index}件を確認しました。次の記事へ移ります…`;}
  }else{run.active=false;run.status='paused';run.message=`${run.index+1}件目は未完了: ${done[url].detail}。確認のため停止しました。`;}
  await chrome.storage.local.set({[DONE_KEY]:allDone,[RUN_KEY]:run});
  if(run.active&&run.status==='loading'){
    await sleep(3500);
    const latest=(await chrome.storage.local.get(RUN_KEY))[RUN_KEY];
    if(latest?.active&&latest.tabId===run.tabId&&latest.index===run.index&&latest.status==='loading'){
      try{await chrome.tabs.update(run.tabId,{url:run.queue[run.index]});}
      catch(err){
        latest.active=false;latest.status='paused';latest.message=`次の記事を開けません: ${err.message}`;
        await chrome.storage.local.set({[RUN_KEY]:latest});
      }
    }
  }
  return {accepted:true};
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  (async()=>{
    switch(message?.type){
      case 'NOTE_STATUS':return await status();
      case 'NOTE_COLLECT_STATUS':return {collection:(await chrome.storage.local.get(COLLECT_KEY))[COLLECT_KEY]||null};
      case 'NOTE_COLLECT_START':return await startCollect(message);
      case 'NOTE_COLLECT_STOP_REQUEST':return await stopCollect();
      case 'NOTE_COLLECT_PROGRESS':
      case 'NOTE_COLLECT_DONE':
      case 'NOTE_COLLECT_FAILED':return await collectFeedback(sender,message);
      case 'NOTE_START':return await start(message);
      case 'NOTE_STOP':{
        const state=await chrome.storage.local.get(RUN_KEY);const run=state[RUN_KEY];
        if(run?.active){
          run.active=false;run.status='paused';run.message='停止しました。現在の記事が追加済みか、マガジンで確認してください。';run.updatedAt=now();
          await chrome.storage.local.set({[RUN_KEY]:run});
        }
        return {stopped:true};
      }
      case 'NOTE_RESULT':return await recordResult(sender,message);
      default:throw Error('未対応の操作です。');
    }
  })().then(x=>reply({ok:true,...x})).catch(e=>reply({ok:false,error:e.message}));
  return true;
});
