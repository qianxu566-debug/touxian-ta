import fs from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
const read=n=>JSON.parse(fs.readFileSync(new URL(n,import.meta.url),'utf8').replace(/^\uFEFF/,''));
const scopes=read('./scopes.json'),glyphs=read('./rank-font.json');
const day=t=>new Date(Date.parse(t)+8*3600000).toISOString().slice(0,10);
const date=day(new Date().toISOString()),dir='history',file=dir+'/'+date+'.json.gz';
fs.mkdirSync(dir,{recursive:true});
const snap=fs.existsSync(file)?JSON.parse(gunzipSync(fs.readFileSync(file))):{date,scopes:[],catalogObservations:[]};
const catalog=process.argv[2]?JSON.parse(gunzipSync(fs.readFileSync(process.argv[2]))):{books:[]};
const observed=new Map(snap.catalogObservations.map(b=>[b.id,b]));
for(const b of catalog.books)if(b.observed && day(b.observed)===date && Number.isFinite(b.readers))
  observed.set(b.id,{id:b.id,readers:b.readers,words:b.wordsObserved===b.observed?b.words:null,observed:b.observed});
snap.catalogObservations=[...observed.values()];
function save(){fs.writeFileSync(file+'.tmp',gzipSync(JSON.stringify(snap)));fs.renameSync(file+'.tmp',file)}
function num(value){return /^\d+$/.test(String(value))?Number(value):null}
let stop=process.argv.includes('--observations-only');
for(const [gender,cid,category] of scopes)for(const mold of [2,1]){
  const key=[gender,cid,mold].join('/');
  if(stop||snap.scopes.some(s=>s.key===key&&s.ok))continue;
  const entry={key,gender,cid,category,mold,observed:new Date().toISOString(),ok:false};
  try{
    await delay(425);
    const q=new URLSearchParams({app_id:2503,rank_list_type:3,offset:0,limit:30,category_id:cid,rank_version:'',gender,rankMold:mold});
    const r=await fetch('https://fanqienovel.com/api/rank/category/list?'+q,{signal:AbortSignal.timeout(15000)});
    if(!r.ok||r.headers.has('retry-after')){stop=true;throw Error('HTTP '+r.status)}
    const j=await r.json();
    if(j.code!==0||!Array.isArray(j.data?.book_list))throw Error('官方状态 '+j.code);
    const decode=v=>String(v||'').replace(/[\uE000-\uF8FF]/gu,c=>{
      const x=glyphs[c.codePointAt(0)];if(!x||!r.headers.get('x-tt-zhal')?.includes('DNMrHsV173Pd4pgy'))throw Error('榜单字体变化');return x});
    entry.version=String(j.data.rankVersion||'');
    const ids=new Set(),positions=new Set();
    entry.rows=j.data.book_list.map(b=>{
      const id=String(b.bookId),pos=num(b.currentPos);
      if(!/^\d+$/.test(id)||!pos||pos>30||ids.has(id)||positions.has(pos))throw Error('榜单名次或书号无效');
      ids.add(id);positions.add(pos);
      const row={id,pos,readers:num(b.read_count),words:num(b.wordNumber),status:({'0':'已完结','1':'连载中'})[b.creationStatus],title:decode(b.bookName),author:decode(b.author)};
      row.intro=decode(b.abstract);row.coverUrl=b.thumbUri;
      return row;
    });
    if(!entry.rows.length)throw Error('榜单为空，未确认是否发布');
    entry.ok=true;
  }catch(e){entry.error=e.message;delete entry.rows;console.warn(key,entry.error)}
  snap.scopes=snap.scopes.filter(s=>s.key!==key);snap.scopes.push(entry);save();
}
save();
const ok=snap.scopes.filter(s=>s.ok);
console.log(JSON.stringify({date,expected:scopes.length*2,ok:ok.length,rows:ok.reduce((n,s)=>n+s.rows.length,0),catalogObservations:observed.size}));
if(ok.length<scopes.length*2)console.warn('::warning::部分榜单缺采，详情见历史快照');
if(!ok.length)process.exitCode=1;
