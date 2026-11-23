import fs from 'node:fs';
import {setTimeout as wait} from 'node:timers/promises';
const ids=new Set();
let pages=0;
for(let page=0;page<30;page++){
  const q=new URLSearchParams({page_count:18,page_index:page,gender:-1,category_id:-1,creation_status:-1,word_count:-1,book_type:-1,sort:0});
  try{
    const res=await fetch('https://fanqienovel.com/api/author/library/book_list/v0/?'+q,{signal:AbortSignal.timeout(15000)});
    if(!res.ok||res.headers.has('retry-after'))throw Error('HTTP '+res.status);
    const j=await res.json(),rows=j.data?.book_list;
    if(j.code!==0||!Array.isArray(rows))throw Error('官方书库状态 '+j.code);
    const before=ids.size;
    for(const b of rows){if(typeof b.book_id!=='string'||!/^\d+$/.test(b.book_id))throw Error('书号格式发生变化');ids.add(b.book_id)}
    pages++;
    if(!j.data.has_more||before===ids.size)break;
    await wait(500);
  }catch(e){console.warn(e.message);break}
}
if(!ids.size)throw Error('未取得官方热度顺序');
fs.mkdirSync('data',{recursive:true});
fs.writeFileSync('data/hot.tmp',JSON.stringify({observed:new Date().toISOString(),pages,ids:[...ids]}));
fs.renameSync('data/hot.tmp','data/hot.json');
console.log('官方最热书库',pages,'页',ids.size,'个书号');
