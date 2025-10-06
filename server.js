const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const apicache = require('apicache');
const cors = require('cors');

const app = express();
const cache = apicache.middleware;
const PORT = process.env.PORT || 3000;

const ROBLOX_CLIENT_ID = process.env.ROBLOX_CLIENT_ID;
const ROBLOX_CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || '18ba4b700968df8afb968a7d23b6cb5b0e81b62a7ded8bffb3d6b2bd4f8a812ab2ab32d3ebfaadb0e60ab4b8e7ecf1b03e7bfe4b065b1eaccdffa77913208cd3',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));
app.use('/api/', rateLimit({ windowMs: 15*1000, max: 40 }));
app.use(express.static(path.join(__dirname)));

// Helper fetch
async function fetchJson(url, opts={}) {
  const controller = new AbortController();
  const id = setTimeout(()=>controller.abort(), 10000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) throw new Error(`fetch ${url} failed ${res.status}`);
    return res.json();
  } catch(err){ clearTimeout(id); throw err; }
}

// ---------- OAuth ----------

const AUTH_AUTHORIZE = 'https://authorize.roblox.com/oauth/authorize';
const AUTH_TOKEN = 'https://authorize.roblox.com/oauth/token';

// Start OAuth
app.get('/auth', (req,res)=>{
  const state = Math.random().toString(36).slice(2);
  req.session.oauth_state = state;
  const redirect_uri = `${BASE_URL}/auth/callback`;
  const scope = encodeURIComponent('openid profile');
  const url = `${AUTH_AUTHORIZE}?client_id=${ROBLOX_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirect_uri)}&state=${state}&scope=${scope}`;
  res.redirect(url);
});

// OAuth callback
app.get('/auth/callback', async (req,res)=>{
  const { code, state } = req.query;
  if (!code || state !== req.session.oauth_state) return res.status(400).send('Invalid OAuth state or code');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${BASE_URL}/auth/callback`,
    client_id: ROBLOX_CLIENT_ID,
    client_secret: ROBLOX_CLIENT_SECRET
  });

  try {
    const tokenResp = await fetch(AUTH_TOKEN, { method:'POST', body });
    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      console.error('token error', text);
      return res.status(500).send('OAuth token exchange failed');
    }
    const tokenJson = await tokenResp.json();
    req.session.roblox_token = tokenJson.access_token;
    res.redirect('/'); // back to homepage
  } catch(err){
    console.error(err);
    res.status(500).send('OAuth exchange failed');
  }
});

// Logout
app.get('/auth/logout', (req,res)=>{
  delete req.session.roblox_token;
  res.redirect('/');
});

// Get logged-in user
app.get('/api/me', async (req,res)=>{
  if (!req.session.roblox_token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const userResp = await fetch('https://authorize.roblox.com/users/v1/users/authenticated', {
      headers:{ 'Authorization': `Bearer ${req.session.roblox_token}` }
    });
    if (!userResp.ok) throw new Error('Failed to fetch user info');
    const user = await userResp.json();

    const headResp = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${user.id}&size=48x48&format=Png&isCircular=true`);
    const headshot = await headResp.json();
    const headshotUrl = headshot.data?.[0]?.imageUrl || '';

    res.json({ id:user.id, name:user.displayName||user.name, headshot:headshotUrl });
  } catch(err){ console.error(err); res.status(500).json({ error: err.message }); }
});

// ---------- Games API ----------
app.get('/api/games', cache('30 seconds'), async (req,res)=>{
  const limit = Math.min(Number(req.query.limit)||50,100);
  const page = Math.max(Number(req.query.page)||1,1);
  const query = encodeURIComponent(req.query.query||'');
  const sort = Number(req.query.sort)||1;

  try {
    const searchUrl = `https://roblox.com/discover/?Keyword=${query}&Category=9&SortType=${sort}&Limit=${limit}&Page=${page}`;
    const searchJson = await fetchJson(searchUrl);
    const games = (searchJson||[]).map(g=>({
      id: g.PlaceId||g.AssetId,
      name: g.Name||g.Title||g.NameText,
      creator: g.Creator?.Name||g.CreatorName||'Unknown',
      thumbnail: g.Thumbnail?.Url||null,
      playing: g.Playing||null
    }));
    res.json({ page, limit, query:req.query.query||'', sort, data:games });
  } catch(err){ console.error(err); res.status(500).json({ page, limit, query, sort, data:[], error:err.message }); }
});

// Serve SPA
app.get(['/', '/home','/signin','/games','/settings','/terms','/privacy'], (req,res)=>{
  res.sendFile(path.join(__dirname,'index.html'));
});

app.listen(PORT,()=>console.log(`RLBX server running on port ${PORT}`));
