const CN_TIME=8*3600000;
export const dayString=(ms=Date.now())=>new Date(ms+CN_TIME).toISOString().slice(0,10);
export async function compressed(path){
  const r=await fetch(path,{cache:'no-cache'});
  if(!r.ok)throw Error('HTTP '+r.status);
  return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).json();
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
