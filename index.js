const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

/* ---------- helpers ---------- */

function toHex(h) {
  if (/^[a-f0-9]{40}$/i.test(h)) return h.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(h)) {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const ch of h.toUpperCase()) bits += A.indexOf(ch).toString(2).padStart(5, '0');
    let hex = '';
    for (let i = 0; i < 160; i += 4) hex += parseInt(bits.substr(i, 4), 2).toString(16);
    return hex;
  }
  return null;
}

function infoHashFromMagnet(link) {
  const m = (link || '').match(/btih:([a-zA-Z0-9]+)/);
  return m ? toHex(m[1]) : null;
}

// minimal .torrent reader: returns info hash, name, trackers, magnet
function parseTorrent(buf) {
  let pos = 0, infoStart = -1, infoEnd = -1;
  function parseStr() {
    const colon = buf.indexOf(0x3a, pos);
    const len = parseInt(buf.toString('latin1', pos, colon), 10);
    const s = buf.slice(colon + 1, colon + 1 + len);
    pos = colon + 1 + len;
    return s;
  }
  function parse(depth) {
    const c = buf[pos];
    if (c === 0x69) {
      const end = buf.indexOf(0x65, pos);
      const n = Number(buf.toString('latin1', pos + 1, end));
      pos = end + 1;
      return n;
    }
    if (c === 0x6c) {
      pos++;
      const a = [];
      while (buf[pos] !== 0x65) a.push(parse(depth + 1));
      pos++;
      return a;
    }
    if (c === 0x64) {
      pos++;
      const o = {};
      while (buf[pos] !== 0x65) {
        const k = parseStr().toString('latin1');
        const start = pos;
        const v = parse(depth + 1);
        if (depth === 0 && k === 'info') { infoStart = start; infoEnd = pos; }
        o[k] = v;
      }
      pos++;
      return o;
    }
    return parseStr();
  }
  const root = parse(0);
  if (infoStart < 0) throw new Error('not a torrent file');
  const hash = crypto.createHash('sha1').update(buf.slice(infoStart, infoEnd)).digest('hex');
  const name = root.info && root.info.name ? root.info.name.toString('utf8') : 'movie';
  const trackers = [];
  if (root.announce) trackers.push(root.announce.toString());
  if (Array.isArray(root['announce-list'])) {
    root['announce-list'].forEach(t => {
      (Array.isArray(t) ? t : [t]).forEach(x => trackers.push(x.toString()));
    });
  }
  const uniq = [...new Set(trackers)].slice(0, 8);
  const magnet = 'magnet:?xt=urn:btih:' + hash + '&dn=' + encodeURIComponent(name) +
    uniq.map(t => '&tr=' + encodeURIComponent(t)).join('');
  return { hash, name, magnet };
}

/* ---------- stremio addon ---------- */

const manifest = {
  id: 'org.myname.myaddon',
  version: '2.0.0',
  name: 'My Movie Addon',
  description: 'My personal movie library',
  resources: [
    'catalog',
    { name: 'meta', types: ['movie'], idPrefixes: ['my:'] },
    { name: 'stream', types: ['movie'], idPrefixes: ['tt', 'my:'] }
  ],
  types: ['movie'],
  catalogs: [{ type: 'movie', id: 'mylibrary', name: 'My Library' }]
};

app.get('/', (req, res) => res.send('Addon is running'));
app.get('/manifest.json', (req, res) => res.json(manifest));

app.get('/catalog/movie/mylibrary.json', async (req, res) => {
  const { data } = await supabase.from('movies').select('*').order('name');
  const metas = (data || []).map(m => ({
    id: m.id, type: 'movie', name: m.name, poster: m.poster,
    releaseInfo: m.year ? String(m.year) : undefined
  }));
  res.json({ metas });
});

app.get('/meta/movie/:id.json', async (req, res) => {
  const { data } = await supabase.from('movies').select('*').eq('id', req.params.id).maybeSingle();
  if (!data) return res.json({ meta: null });
  res.json({ meta: {
    id: data.id, type: 'movie', name: data.name, poster: data.poster,
    background: data.poster, releaseInfo: data.year ? String(data.year) : undefined
  }});
});

const LABEL = { direct: 'Direct', magnet: 'Magnet', torrent: 'Torrent' };

app.get('/stream/movie/:id.json', async (req, res) => {
  const { data } = await supabase.from('streams').select('*').eq('movie_id', req.params.id).order('id');
  const streams = (data || []).map(s => {
    const name = 'My Addon\n' + s.quality;
    const title = s.quality + ' \u2022 ' + (LABEL[s.kind] || s.kind);
    if (s.kind === 'magnet' || s.kind === 'torrent') {
      const hash = infoHashFromMagnet(s.link);
      if (!hash) return null;
      const sources = [...s.link.matchAll(/[&?]tr=([^&]+)/g)].map(m => 'tracker:' + decodeURIComponent(m[1]));
      const out = { name, title, infoHash: hash };
      if (sources.length) out.sources = sources;
      return out;
    }
    if (s.kind === 'direct') return { name, title, url: s.link };
    return { name, title, externalUrl: s.link };
  }).filter(Boolean);
  res.json({ streams });
});

/* ---------- admin api ---------- */

app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ results: [] });
    const r = await fetch('https://v3-cinemeta.strem.io/catalog/movie/top/search=' + encodeURIComponent(q) + '.json');
    const d = await r.json();
    const results = (d.metas || []).slice(0, 12).map(m => ({
      id: m.imdb_id || m.id, name: m.name,
      year: m.releaseInfo ? parseInt(m.releaseInfo) || null : (m.year ? parseInt(m.year) : null),
      poster: m.poster
    }));
    res.json({ results });
  } catch (e) { res.json({ results: [] }); }
});

app.get('/api/movies', async (req, res) => {
  const { data: movies } = await supabase.from('movies').select('*').order('name');
  const { data: streams } = await supabase.from('streams').select('movie_id,quality');
  const out = (movies || []).map(m => ({
    ...m,
    qualities: [...new Set((streams || []).filter(s => s.movie_id === m.id).map(s => s.quality))]
  }));
  res.json({ movies: out });
});

app.post('/api/delete', async (req, res) => {
  const { error } = await supabase.from('movies').delete().eq('id', req.body.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/add', async (req, res) => {
  try {
    let { id, name, year, poster, qualities } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Movie name is required' });
    name = name.trim();
    const m = (id || '').match(/tt\d+/);
    if (m) id = m[0];
    if (!id) {
      id = 'my:' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + (year ? '-' + year : '');
    }
    const { error: e1 } = await supabase.from('movies').upsert({
      id, name,
      year: year ? parseInt(year) : null,
      poster: poster && poster.trim() ? poster.trim()
        : (id.startsWith('tt') ? 'https://images.metahub.space/poster/medium/' + id + '/img' : null)
    });
    if (e1) throw new Error(e1.message);

    let added = 0;
    for (const q of qualities || []) {
      const quality = q.quality;
      const rows = [];
      const seen = new Set();

      const direct = (q.direct || '').trim();
      if (direct) rows.push({ movie_id: id, quality, kind: 'direct', link: direct });

      const magnet = (q.magnet || '').trim();
      if (magnet) {
        const h = infoHashFromMagnet(magnet);
        if (!h) throw new Error(quality + ': magnet link is not valid');
        seen.add(h);
        rows.push({ movie_id: id, quality, kind: 'magnet', link: magnet });
      }

      let buf = null;
      if (q.torrentFile && q.torrentFile.data) buf = Buffer.from(q.torrentFile.data, 'base64');
      else if (q.torrentUrl && q.torrentUrl.trim()) {
        const r = await fetch(q.torrentUrl.trim());
        if (!r.ok) throw new Error(quality + ': could not download the torrent URL');
        buf = Buffer.from(await r.arrayBuffer());
      }
      if (buf) {
        let t;
        try { t = parseTorrent(buf); } catch (e) { throw new Error(quality + ': torrent file could not be read'); }
        if (!seen.has(t.hash)) rows.push({ movie_id: id, quality, kind: 'torrent', link: t.magnet });
      }

      if (!rows.length) continue;
      const { error: ed } = await supabase.from('streams').delete().eq('movie_id', id).eq('quality', quality);
      if (ed) throw new Error(ed.message);
      const { error: ei } = await supabase.from('streams').insert(rows);
      if (ei) throw new Error(ei.message);
      added += rows.length;
    }
    res.json({ added, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- admin page ---------- */

app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Movie Admin</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#141414;color:#fff;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif}
header{padding:18px 4%;background:linear-gradient(180deg,rgba(0,0,0,.9),#141414);border-bottom:1px solid #222}
.logo{color:#E50914;font-weight:900;font-size:28px;letter-spacing:3px;text-transform:uppercase}
.wrap{max-width:900px;margin:0 auto;padding:24px 4% 80px}
h2{font-size:22px;margin:28px 0 12px}
label{display:block;font-size:13px;color:#b3b3b3;margin:12px 0 6px}
input{width:100%;padding:12px;background:#333;border:1px solid #333;border-radius:4px;color:#fff;font-size:15px}
input:focus{outline:none;border-color:#E50914}
input[type=file]{padding:9px;background:#262626}
.row{display:flex;gap:10px}
.row>*{flex:1}
.row .small{flex:0 0 110px}
button{padding:12px 20px;border:0;border-radius:4px;background:#E50914;color:#fff;font-weight:700;font-size:15px;cursor:pointer}
button:hover{background:#f6121d}
button.grey{background:#333}
button.grey:hover{background:#444}
button.big{width:100%;font-size:17px;padding:15px;margin-top:22px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px;margin-top:14px}
.grid img{width:100%;border-radius:4px;cursor:pointer;border:3px solid transparent;display:block;background:#222;min-height:150px}
.grid img:hover{border-color:#888}
.grid .sel{border-color:#E50914}
.grid small{display:block;font-size:11px;color:#b3b3b3;margin-top:4px}
.chosen{margin-top:12px;padding:10px 12px;background:#1f1f1f;border-left:4px solid #E50914;font-size:14px}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:10px}
@media(max-width:700px){.cards{grid-template-columns:1fr}.row{flex-direction:column}.row .small{flex:1}}
.card{background:#181818;border:1px solid #2a2a2a;border-radius:8px;padding:6px 16px 18px}
.card h3{margin:14px 0 4px;font-size:18px}
.badge{background:#E50914;border-radius:3px;padding:2px 8px;font-size:14px;margin-right:6px}
#msg{margin-top:16px;padding:12px;border-radius:4px;display:none;font-weight:700}
.ok{background:#1c3b22;color:#7dd68d}
.err{background:#3b1c1c;color:#ff8a8a}
.item{display:flex;align-items:center;gap:12px;padding:10px;background:#181818;border-radius:6px;margin-bottom:8px}
.item img{width:40px;height:58px;object-fit:cover;border-radius:3px;background:#222}
.item div{flex:1}
.item small{color:#b3b3b3}
.item button{padding:8px 12px;font-size:13px}
</style></head><body>
<header><div class="logo">Movie Admin</div></header>
<div class="wrap">

<h2>1. Find the movie</h2>
<div class="row">
  <input id="q" placeholder="Movie name, e.g. Swapped" onkeydown="if(event.key==='Enter')find()">
  <button class="small" onclick="find()">Find</button>
</div>
<div id="results" class="grid"></div>
<div id="chosen" class="chosen" style="display:none"></div>
<div class="row">
  <div class="small"><label>Year (optional)</label><input id="year" placeholder="2026"></div>
  <div><label>Poster URL (optional)</label><input id="poster" placeholder="auto-filled when you pick a movie"></div>
</div>

<h2>2. Add links</h2>
<div id="cards" class="cards"></div>

<button class="big" onclick="save()">Save Movie</button>
<div id="msg"></div>

<h2>My Library</h2>
<div id="list"></div>

</div>
<script>
var QUAL=['1080p','4K'];
var selected=null;
var found=[];

QUAL.forEach(function(q,i){
  var d=document.createElement('div');
  d.className='card';
  d.innerHTML='<h3><span class="badge">'+q+'</span>'+(q==='4K'?'Ultra HD':'Full HD')+'</h3>'
   +'<label>Direct link</label><input id="direct'+i+'" placeholder="https://site.com/movie.mkv">'
   +'<label>Magnet link</label><input id="magnet'+i+'" placeholder="magnet:?xt=urn:btih:...">'
   +'<label>Torrent file</label><input id="tfile'+i+'" type="file" accept=".torrent">'
   +'<label>or Torrent file URL</label><input id="turl'+i+'" placeholder="https://site.com/movie.torrent">';
  document.getElementById('cards').appendChild(d);
});

function show(text,ok){
  var m=document.getElementById('msg');
  m.style.display='block';
  m.className=ok?'ok':'err';
  m.textContent=text;
}

async function find(){
  var q=document.getElementById('q').value.trim();
  if(!q)return;
  var box=document.getElementById('results');
  box.innerHTML='Searching...';
  var r=await fetch('/api/search?q='+encodeURIComponent(q));
  var d=await r.json();
  found=d.results||[];
  box.innerHTML='';
  if(!found.length){box.textContent='No match found. You can still save with the name above.';return;}
  found.forEach(function(m,i){
    var w=document.createElement('div');
    var img=document.createElement('img');
    img.src=m.poster||'';
    img.onclick=function(){pick(i);};
    img.id='p'+i;
    var s=document.createElement('small');
    s.textContent=m.name+(m.year?' ('+m.year+')':'');
    w.appendChild(img);w.appendChild(s);
    box.appendChild(w);
  });
}

function pick(i){
  selected=found[i];
  found.forEach(function(x,j){document.getElementById('p'+j).className=(j===i?'sel':'');});
  document.getElementById('year').value=selected.year||'';
  document.getElementById('poster').value=selected.poster||'';
  var c=document.getElementById('chosen');
  c.style.display='block';
  c.textContent='Selected: '+selected.name+(selected.year?' ('+selected.year+')':'')+'  \u2022  '+selected.id;
}

function readFile(f){
  return new Promise(function(res){
    var r=new FileReader();
    r.onload=function(){res({name:f.name,data:String(r.result).split(',')[1]});};
    r.readAsDataURL(f);
  });
}

async function save(){
  var name=selected?selected.name:document.getElementById('q').value.trim();
  if(!name){show('Type the movie name and press Find first.',false);return;}
  var qualities=[];
  for(var i=0;i<QUAL.length;i++){
    var f=document.getElementById('tfile'+i).files[0];
    qualities.push({
      quality:QUAL[i],
      direct:document.getElementById('direct'+i).value,
      magnet:document.getElementById('magnet'+i).value,
      torrentUrl:document.getElementById('turl'+i).value,
      torrentFile:f?await readFile(f):null
    });
  }
  var body={
    id:selected?selected.id:'',
    name:name,
    year:document.getElementById('year').value,
    poster:document.getElementById('poster').value,
    qualities:qualities
  };
  show('Saving...',true);
  var r=await fetch('/api/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  var d=await r.json();
  if(d.error){show('Error: '+d.error,false);return;}
  show('Saved! '+d.added+' link(s) added.',true);
  loadList();
}

async function loadList(){
  var r=await fetch('/api/movies');
  var d=await r.json();
  var box=document.getElementById('list');
  box.innerHTML='';
  (d.movies||[]).forEach(function(m){
    var it=document.createElement('div');
    it.className='item';
    var img=document.createElement('img');
    img.src=m.poster||'';
    var t=document.createElement('div');
    t.innerHTML='<b></b><br><small></small>';
    t.querySelector('b').textContent=m.name+(m.year?' ('+m.year+')':'');
    t.querySelector('small').textContent=m.id+'  \u2022  '+(m.qualities.join(', ')||'no links');
    var b=document.createElement('button');
    b.className='grey';
    b.textContent='Delete';
    b.onclick=async function(){
      if(!confirm('Delete '+m.name+'?'))return;
      await fetch('/api/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:m.id})});
      loadList();
    };
    it.appendChild(img);it.appendChild(t);it.appendChild(b);
    box.appendChild(it);
  });
  if(!(d.movies||[]).length)box.textContent='No movies yet.';
}
loadList();
</script></body></html>`);
});

app.listen(process.env.PORT || 7000, () => console.log('Running'));
