const CN_TIME=8*3600000;
const DATA_CACHE_NAME='touxian-data-v1';
export const dayString=(ms=Date.now())=>new Date(ms+CN_TIME).toISOString().slice(0,10);

function cacheUrl(path){return new URL(path,location.href).href;}
async function openDataCache(){
  try{return (typeof caches!=='undefined'&&caches?.open)?await caches.open(DATA_CACHE_NAME):null;}catch{return null;}
}
async function decodeBuf(buf,gz){
  if(!buf||!buf.byteLength)throw Error('EMPTY_BODY');
  if(gz)return new Response(new Response(buf).body.pipeThrough(new DecompressionStream('gzip'))).json();
  return JSON.parse(new TextDecoder().decode(buf));
}
export async function fetchWithRetry(path,{gz=true,timeoutMs=14000,retries=2,ver='',noCache=false}={}){
  const url=ver?path+(path.includes('?')?'&':'?')+'v='+encodeURIComponent(ver):path;
  for(let attempt=0;attempt<=retries;attempt++){
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(Error('TIMEOUT')),timeoutMs);
    try{
      const r=await fetch(url,{cache:(noCache||!ver)?'no-cache':'default',signal:ctrl.signal});
      if(!r.ok){const e=Error('HTTP '+r.status);e.status=r.status;throw e;}
      const buf=await r.arrayBuffer();
      const data=await decodeBuf(buf,gz);
      return {data,buf};
    }catch(err){
      if(attempt>=retries||err?.status===404)throw err;
      await new Promise(res=>setTimeout(res,(attempt+1)*900));
    }finally{
      clearTimeout(timer);
    }
  }
}
export async function readCachedData(path,{gz=true}={}){
  const cache=await openDataCache();
  if(!cache)return null;
  const key=cacheUrl(path);
  try{
    const res=await cache.match(key);
    if(!res)return null;
    const ver=res.headers.get('X-Touxian-Ver')||'';
    const buf=await res.arrayBuffer();
    const data=await decodeBuf(buf,gz);
    return {data,ver};
  }catch{
    try{await cache.delete(key);}catch{}
    return null;
  }
}
export async function writeCachedData(path,buf,ver=''){
  const cache=await openDataCache();
  if(!cache)return;
  try{
    await cache.put(cacheUrl(path),new Response(buf,{headers:{'Content-Type':'application/octet-stream','X-Touxian-Ver':String(ver||''),'X-Touxian-At':String(Date.now())}}));
  }catch{}
}
export async function pruneHistoryCache(maxKeep=6){
  const cache=await openDataCache();
  if(!cache)return;
  try{
    const keys=await cache.keys();
    const hist=keys.filter(req=>/\/history\/\d{4}-\d{2}-\d{2}\.json\.gz$/i.test(new URL(req.url).pathname));
    if(hist.length<=maxKeep)return;
    const dated=await Promise.all(hist.map(async req=>{
      const r=await cache.match(req);
      return {req,at:Number(r?.headers?.get('X-Touxian-At')||0)};
    }));
    dated.sort((a,b)=>b.at-a.at);
    await Promise.all(dated.slice(maxKeep).map(x=>cache.delete(x.req)));
  }catch{}
}
export async function fetchCached(path,{gz=true,timeoutMs=14000,retries=2,ver='',forceNetwork=false,noCache=false}={}){
  if(!forceNetwork&&ver){
    const hit=await readCachedData(path,{gz});
    if(hit&&hit.ver===ver)return {data:hit.data,fromCache:true,ver};
  }
  const {data,buf}=await fetchWithRetry(path,{gz,timeoutMs,retries,ver,noCache});
  await writeCachedData(path,buf,ver);
  return {data,fromCache:false,ver};
}
export async function compressed(path,opts={}){
  return (await fetchWithRetry(path,{gz:true,...opts})).data;
}
export function ageDays(start,date){
  if(!start||!date)return null;
  const n=(Date.parse(date)-Date.parse(start))/86400000;
  return Number.isFinite(n)&&n>=0?n:null;
}
export function mobilePlatform(){
  if(/iPhone|iPad|iPod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1))return 'ios';
  if(/Android/i.test(navigator.userAgent))return 'android';
  return '';
}
export function isWeChat(){
  return /\bMicroMessenger\//i.test(navigator.userAgent);
}
export function isAndroidAppShell(){
  if(typeof window!=='undefined'&&window.TouxianNativeShelf)return true;
  const ua=navigator.userAgent||'';
  const isAndroidWv=/Android/i.test(ua)&&/;\s*wv\)/i.test(ua);
  const isKnownHost=/MicroMessenger|QQ\/|MQQBrowser|Alipay|Weibo|DingTalk|baiduboxapp|NewsArticle|aweme|UCBrowser|Quark|EdgA|Firefox|SamsungBrowser|MiuiBrowser|HeyTapBrowser|VivoBrowser|HuaweiBrowser/i.test(ua);
  return isAndroidWv&&!isKnownHost;
}
export function isStandaloneApp(){
  if(isAndroidAppShell())return true;
  return Boolean(window.matchMedia?.('(display-mode: standalone)')?.matches||navigator.standalone===true);
}
export function appLink(id,platform){
  if(!/^\d+$/.test(id)||!['ios','android'].includes(platform))return '';
  // The novel reader route in Fanqie's share-v2 page uses camel-case bookId.
  return 'dragon1967://reading?'+new URLSearchParams({bookId:id});
}
const comparisons=new Map();
export async function compare(id,at,now){
  if(!at||!Number.isFinite(now))return '这次记录缺少可比较的在读值。';
  if(!comparisons.has(at))comparisons.set(at,compressed('./history/'+at+'.comparisons.gz').catch(e=>{comparisons.delete(at);throw e}));
  const previous=(await comparisons.get(at))[id]||[];
  const items=[1,7,30].flatMap((n,i)=>{
    const old=previous[i];if(!Number.isFinite(old))return [];
    const delta=now-old, sign=delta>0?'+':'';
    return [(n===1?'较昨日':'近 '+n+' 天')+'　'+sign+delta.toLocaleString('zh-CN')+' 人'+(old?'（'+sign+(100*delta/old).toFixed(1)+'%）':'')];
  });
  return items.length?items.join('　 ·　 '):'正在积累记录，暂无相隔 1、7 或 30 天的可比数据。';
}
