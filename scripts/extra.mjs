import fs from 'node:fs';
import {gunzipSync,gzipSync} from 'node:zlib';
import {setTimeout as pause} from 'node:timers/promises';
const dateOf=t=>new Date(t+8*3600000).toISOString().slice(0,10);
const date=dateOf(Date.now()), file='history/'+date+'.json.gz';
function read(path){return JSON.parse(gunzipSync(fs.readFileSync(path)))}
function save(path,value){fs.writeFileSync(path+'.tmp',gzipSync(JSON.stringify(value)));fs.renameSync(path+'.tmp',path)}
const snapshot=read(file), catalog=read(process.argv[2]);
fs.mkdirSync('data',{recursive:true});
const metaFile='data/book-dates.json.gz';
const meta=fs.existsSync(metaFile)?read(metaFile):{};
let stopped=false;
async function get(url){
  await pause(450);
  const r=await fetch(url,{signal:AbortSignal.timeout(14000)});
  if(!r.ok||r.headers.has('retry-after')){
    stopped=[401,403,429].includes(r.status)||r.headers.has('retry-after');
    throw Error('HTTP '+r.status);
  }
  const j=await r.json();if(j.code!==0)throw Error('官方状态 '+j.code);
  return j;
}
snapshot.boards??={};
for(const [mold,side] of [[3,0],[4,13],[5,12],[6,10]]){
  if(stopped||snapshot.boards[mold]?.rows?.length)continue;
  try{
    const j=await get(side?'https://api-lf.fanqiesdk.com/api/novel/channel/homepage/rank/rank_list/v2/?aid=13&limit=30&offset=0&side_type='+side+'&type=1':'https://fanqienovel.com/api/author/misc/top_book_list/v1/?limit=30&offset=0');
    const list=side?j.data.result:j.book_list;
    if(!Array.isArray(list)||!list.length)throw Error('空榜单');
    const rows=list.map((b,i)=>{
      if(typeof b.book_id!=='string'||!/^\d+$/.test(b.book_id)||!b.book_name)throw Error('无效作品');
      return {id:b.book_id,title:b.book_name,author:b.author,pos:i+1,readers:/^\d+$/.test(b.read_count)?Number(b.read_count):null,coverUrl:b.thumb_url,intro:b.abstract,primary:side?[]:[b.category].filter(Boolean),tags:side?(b.category_v2||[]):[]};
    });
    if(new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('榜内重复');
    snapshot.boards[mold]={observed:new Date().toISOString(),rows};
  }catch(e){snapshot.boards[mold]={error:e.message};console.warn('::warning::榜单 '+mold+' '+e.message)}
  save(file,snapshot);
}
const sorted=[...catalog.books].sort((a,b)=>b.readers-a.readers);
const ids=sorted.filter(b=>!meta[b.id]?.start).map(b=>b.id);
let failures=0,checked=0;
for(const id of ids){
  if(stopped||checked>=Number(process.argv[3]||60)||failures>=3)break;
  checked++;
  try{
    const j=await get('https://fanqienovel.com/api/reader/directory/detail?bookId='+id);
    const chapters=j.data.chapterListWithVolume.flat();
    const first=chapters.find(c=>String(c.realChapterOrder)==='1');
    if(!first||!(Number(first.firstPassTime)>0))throw Error('缺首章日期');
    meta[id]={start:dateOf(Number(first.firstPassTime)*1000),checked:date};
    failures=0;save(metaFile,meta);
  }catch(e){failures++;console.warn('资料',id,e.message)}
}
save(metaFile,meta);
console.log(JSON.stringify({date,boards:Object.fromEntries(Object.entries(snapshot.boards).map(([k,v])=>[k,v.rows?.length||0])),dates:Object.keys(meta).length,checked}));

