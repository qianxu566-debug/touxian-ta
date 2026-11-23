import {dayString} from './reader.js';
const archive='https://raw.githubusercontent.com/qianxu566-debug/fanshu-reader-observations/main/days/';
const requests=new Map();
export const earlier=(date,n)=>new Date(Date.parse(date)-86400000*n).toISOString().slice(0,10);
async function load(base,day){
  const r=await fetch(base+day+'.json.gz',{cache:'no-cache',signal:AbortSignal.timeout(8000)});
  if(!r.ok)return null;
  const data=await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).json();
  return data.date===day&&data.source==='fanqienovel.com/api/book/info:readCount'&&data.rows?data:null;
}
async function remote(day){
  try{
    const record=await load(archive,day);
    if(record)return record;
  }catch{}
  const endpoint='https://api.github.com/repos/qianxu566-debug/fanshu-reader-observations/contents/days/'+day+'.json.gz';
  const res=await fetch(endpoint,{headers:{Accept:'application/vnd.github.raw+json'},cache:'no-cache',signal:AbortSignal.timeout(6000)});
  if(!res.ok)return null;
  const record=await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).json();
  return record.date===day&&record.source==='fanqienovel.com/api/book/info:readCount'&&record.rows?record:null;
}
function mergeSamples(local,remote){
  const rows={...remote.rows};
  for(const [id,row] of Object.entries(local.rows)){
    const other=rows[id];
    if(!other||row[0]>other[0]||row[0]===other[0]&&row.length>other.length)rows[id]=row;
  }
  return {...remote,rows};
}
export function samples(day){
  if(!requests.has(day)){
    requests.set(day,Promise.all([remote(day).catch(()=>null),load('./data/days/',day).catch(()=>null)])
      .then(([remote,local])=>remote&&local?mergeSamples(local,remote):remote||local));
  }
  return requests.get(day);
}
export function count(sample,id){
  const row=sample?.rows[id];
  return row&&dayString(row[0]*1000)===sample.date&&Number.isSafeInteger(row[1])&&row[1]>=0?row[1]:null;
}
export function difference(now,prior){
  if(now===null||prior===null)return '';
  const delta=now-prior,sign=delta>0?'+':'';
  const pct=prior?('（'+sign+(100*delta/prior).toFixed(2)+'%）'):'';
  return sign+delta.toLocaleString('zh-CN')+' 人'+pct;
}
export async function historyText(id,day){
  const [current,...old]=await Promise.all([0,1,7,30].map(n=>samples(earlier(day,n))));
  const value=count(current,id);
  if(value===null)return '这一天还没有这本书的详情在读记录。';
  const changes=old.map((s,i)=>{const diff=difference(value,count(s,id));return diff&&['较昨日','近 7 天','近 30 天'][i]+' '+diff}).filter(Boolean);
  return changes.join(' · ')||'当天在读已记录，等待对应日期的同源记录。';
}
