const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const app = express();
app.use(cors());

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
    const name = `My Addon\n${s.quality}`;
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

app.listen(process.env.PORT || 7000, () => console.log('Running'));
