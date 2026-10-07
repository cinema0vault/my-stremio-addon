const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const app = express();
app.use(cors());
app.use(express.json());

const manifest = {
  id: 'org.myname.myaddon',
  version: '1.0.0',
  name: 'My Movie Addon',
  description: 'My personal movie library',
  resources: ['catalog', 'stream'],
  types: ['movie'],
  idPrefixes: ['tt', 'my:'],
  catalogs: [{ type: 'movie', id: 'mylibrary', name: 'My Library' }]
};

app.get('/', (req, res) => res.send('Addon is running'));
app.get('/manifest.json', (req, res) => res.json(manifest));

app.get('/catalog/movie/mylibrary.json', async (req, res) => {
  const { data } = await supabase.from('movies').select('*');
  const metas = (data || []).map(m => ({
    id: m.id,
    type: 'movie',
    name: m.name,
    poster: m.poster,
    releaseInfo: m.year ? String(m.year) : undefined
  }));
  res.json({ metas });
});

app.get('/stream/movie/:id.json', async (req, res) => {
  const { data } = await supabase.from('streams').select('*').eq('movie_id', req.params.id);
  const streams = (data || []).map(s => {
    const name = 'My Addon\n' + s.quality;
    if (s.kind === 'magnet') {
      const hash = (s.link.match(/btih:([a-zA-Z0-9]+)/) || [])[1];
      if (!hash) return null;
      return { name, title: s.quality, infoHash: hash.toLowerCase() };
    }
    if (s.kind === 'direct') return { name, title: s.quality, url: s.link };
    return { name, title: s.quality, externalUrl: s.link };
  }).filter(Boolean);
  res.json({ streams });
});

/* ---------- ADMIN PAGE ---------- */

app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Add Movie</title>
<style>
body{font-family:sans-serif;max-width:600px;margin:20px auto;padding:0 12px;background:#111;color:#eee}
input,textarea,button{width:100%;padding:10px;margin:6px 0 14px;box-sizing:border-box;border-radius:6px;border:1px solid #444;background:#222;color:#eee;font-size:15px}
button{background:#7b5bf5;border:0;cursor:pointer;font-weight:bold}
small{color:#999}
#msg{padding:10px;font-weight:bold}
</style></head><body>
<h2>Add Movie</h2>
<label>Admin password</label>
<input id="password" type="password">
<label>IMDb ID <small>(from the imdb.com/title/tt0133093 URL)</small></label>
<input id="id" placeholder="tt0133093">
<label>Movie name</label>
<input id="name" placeholder="The Matrix">
<label>Year <small>(optional)</small></label>
<input id="year" placeholder="1999">
<label>Poster image URL <small>(optional, auto-filled if empty)</small></label>
<input id="poster">
<label>Links <small>(one per line: quality | link)</small></label>
<textarea id="links" rows="7" placeholder="4K | magnet:?xt=urn:btih:...
1080p | https://site.com/movie.mp4
720p | https://site.com/watch/page"></textarea>
<button onclick="save()">Save Movie</button>
<div id="msg"></div>
<script>
async function save(){
  var body={
    password:document.getElementById('password').value,
    id:document.getElementById('id').value,
    name:document.getElementById('name').value,
    year:document.getElementById('year').value,
    poster:document.getElementById('poster').value,
    links:document.getElementById('links').value
  };
  var r=await fetch('/api/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  var d=await r.json();
  document.getElementById('msg').textContent=d.error?('Error: '+d.error):('Saved! '+d.added+' link(s) added.');
  if(!d.error){
    ['id','name','year','poster','links'].forEach(function(x){document.getElementById(x).value='';});
  }
}
</script></body></html>`);
});

app.post('/api/add', async (req, res) => {
  const { password, id, name, year, poster, links } = req.body;
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Wrong password' });
  if (!id || !name) return res.status(400).json({ error: 'IMDb ID and name are required' });

  const movieId = id.trim();
  const { error: e1 } = await supabase.from('movies').upsert({
    id: movieId,
    name: name.trim(),
    year: year ? parseInt(year) : null,
    poster: poster && poster.trim() ? poster.trim()
      : 'https://images.metahub.space/poster/medium/' + movieId + '/img'
  });
  if (e1) return res.status(500).json({ error: e1.message });

  const rows = (links || '').split('\n').map(l => l.trim()).filter(l => l.includes('|')).map(l => {
    const i = l.indexOf('|');
    const quality = l.slice(0, i).trim();
    const link = l.slice(i + 1).trim();
    let kind = 'external';
    if (link.toLowerCase().startsWith('magnet:')) kind = 'magnet';
    else if (/\.(mp4|mkv|m3u8|webm)(\?|$)/i.test(link)) kind = 'direct';
    return { movie_id: movieId, quality, kind, link };
  }).filter(r => r.link);

  if (rows.length) {
    const { error: e2 } = await supabase.from('streams').insert(rows);
    if (e2) return res.status(500).json({ error: e2.message });
  }
  res.json({ added: rows.length });
});

app.listen(process.env.PORT || 7000, () => console.log('Running'));
