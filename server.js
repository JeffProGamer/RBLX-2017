// server.js
// RLBX 2017: Server-side app for Render
// Node 18+ recommended

const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const cors = require('cors');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const apicache = require('apicache');

const app = express();
const cache = apicache.middleware;
const PORT = process.env.PORT || 3000;

// === CONFIG (set these env vars in Render) ===
// ROBLOX_CLIENT_ID, ROBLOX_CLIENT_SECRET, BASE_URL (e.g. https://rblx-2017.onrender.com)
const ROBLOX_CLIENT_ID = process.env.ROBLOX_CLIENT_ID || '6438392192740765716';
const ROBLOX_CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET || 'RBX-xXCEXLXi-E6pOKm8E_OZJ9IV20B2nCA-n7ExOQ7VnB7jHoEuYePvuIQdDpTztCe-';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// === SECURITY & BASE MIDDLEWARE ===
app.use(cors()); // allow all origins for now; lock down in production
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.c,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // set to true with HTTPS in production
}));

const limiter = rateLimit({ windowMs: 15 * 1000, max: 40 });
app.use('/api/', limiter);

// Serve static (index.html, images) from repo root
app.use(express.static(path.join(__dirname)));

// ---------- Helper fetch with timeout ----------
async function fetchJson(url, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) throw new Error(`fetch ${url} failed ${res.status}`);
    return res.json();
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// ---------- ROBLOX OAUTH 2.0 (Authorization Code Flow) ----------
// Docs: https://create.roblox.com/docs/cloud/auth/oauth2-overview
// Register an OAuth app in Roblox to get client_id & client_secret.
// Endpoints in docs: authorization endpoint and token endpoint paths used below.

const AUTH_AUTHORIZE = 'https://apis.roblox.com/oauth/authorize'; // may be /oauth/authorize
const AUTH_TOKEN = 'https://apis.roblox.com/oauth/token'; // may be /oauth/token

// Kick off OAuth flow
app.get('/auth/roblox', (req, res) => {
  const state = Math.random().toString(36).slice(2);
  req.session.oauth_state = state;
  const redirect_uri = `${BASE_URL}/auth/roblox/callback`;
  const scope = encodeURIComponent('openid profile'); // adjust scopes per Roblox docs
  const url = `${AUTH_AUTHORIZE}?client_id=${ROBLOX_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirect_uri)}&state=${state}&scope=${scope}`;
  return res.redirect(url);
});

// OAuth callback
app.get('/auth/roblox/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || state !== req.session.oauth_state) return res.status(400).send('Invalid OAuth state or code');

  const tokenUrl = AUTH_TOKEN;
  const redirect_uri = `${BASE_URL}/auth/roblox/callback`;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri,
    client_id: ROBLOX_CLIENT_ID,
    client_secret: ROBLOX_CLIENT_SECRET
  });

  try {
    const tokenResp = await fetch(tokenUrl, { method: 'POST', body });
    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      console.error('token error', text);
      return res.status(500).send('OAuth token exchange failed');
    }
    const tokenJson = await tokenResp.json();
    // tokenJson contains access_token; store in session
    req.session.roblox_token = tokenJson.access_token;
    // you can fetch user profile with that token now
    return res.redirect('/'); // signed in -> home
  } catch (err) {
    console.error(err);
    return res.status(500).send('OAuth exchange failed');
  }
});

// Simple logout
app.get('/auth/logout', (req, res) => {
  delete req.session.roblox_token;
  res.redirect('/');
});

// ---------- API: /api/topgames (paginated) ----------
// Returns live games listing from Roblox with pagination.
// IMPORTANT: Roblox has several "discover" endpoints — this uses a documented games list pattern where possible.
// You can request ?limit=50&page=1
app.get('/api/topgames', cache('30 seconds'), async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const page = Math.max(Number(req.query.page) || 1, 1);
  // NOTE: The exact "discover" endpoint and query parameters may change; adjust if necessary.
  // We'll try the documented 'games' endpoints and fall back to 'explore' if available.
  try {
    // Example attempt (may require later tuning): use the "games" explore endpoint if available
    const offset = (page - 1) * limit;
    const apiUrl = `https://games.roblox.com/v1/games/list?sortOrder=Desc&limit=${limit}&cursor=${offset}`; // if unsupported, adapt in logs
    let json;
    try {
      json = await fetchJson(apiUrl);
    } catch (err) {
      // fallback: try an "explore" endpoint or other stable feed might be needed (undocumented endpoints).
      // As robust fallback, fetch curated popular universes by scanning a smaller list (not ideal).
      console.warn('topgames primary endpoint failed, returning empty', err.message);
      return res.json({ data: [] });
    }

    // json expected to contain list of games with universeId and playing
    const games = (json.data || json.games || []).map(g => ({
      id: g.id || g.universeId || g.rootPlaceId || g.id,
      name: g.name,
      creator: g.creator?.name || g.creator?.nameText || (g.creator && g.creator.name) || 'Unknown',
      thumbnail: g.thumbnailUrl || null,
      playing: typeof g.playing === 'number' ? g.playing : (g.playingCount || null)
    }));
    res.json({ page, limit, data: games });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: /api/search?query=xxx&page=1&limit=20 ----------
// Search games by keyword. Roblox's search endpoints are partly undocumented; try a few options and return results.
app.get('/api/search', cache('20 seconds'), async (req, res) => {
  const q = (req.query.query || '').trim();
  if (!q) return res.status(400).json({ error: 'query required' });
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const page = Math.max(Number(req.query.page) || 1, 1);

  try {
    // Try the "search" endpoint used by site (may be undocumented). If it fails, return empty with message.
    // Example (may require debugging): https://search.roblox.com/catalog/json?Keyword=...
    const searchUrl = `https://search.roblox.com/catalog/json?Keyword=${encodeURIComponent(q)}&Category=9&Limit=${limit}&SortType=1&Page=${page}`;
    // Category=9 historically refers to experiences/games.
    const searchJson = await fetchJson(searchUrl);
    // The returned schema varies; map to a common form when possible
    const items = (searchJson || []).map(item => ({
      id: item.PlaceId || item.AssetId || item.Id,
      name: item.Name || item.Title || item.NameText || item.name,
      creator: item.Creator && (item.Creator.Name || item.Creator.NameText) || item.CreatorName || 'Unknown',
      thumbnail: item.Thumbnail && item.Thumbnail.Url ? item.Thumbnail.Url : item.ThumbnailUrl || null
    }));
    res.json({ page, limit, query: q, data: items });
  } catch (err) {
    console.error('search error', err);
    res.status(500).json({ error: 'search failed', detail: err.message });
  }
});

// ---------- API: /api/game/:placeId or :universeId -> details + playing count ----------
// We accept both placeId or universeId; we will normalize using multiget-place-details
app.get('/api/game/:id', cache('10 seconds'), async (req, res) => {
  const id = req.params.id;
  try {
    // First try multiget-place-details (documented) to get universeId and metadata
    const placeDetailsUrl = `https://games.roblox.com/v1/games/multiget-place-details?placeIds=${id}`;
    const pd = await fetchJson(placeDetailsUrl);
    const info = pd && pd[0] ? pd[0] : null;
    if (!info) return res.status(404).json({ error: 'game not found' });

    // Universe and rootPlace info
    const universeId = info.universeId || info.rootPlaceId || info.id;
    const rootPlaceId = info.rootPlaceId || info.placeId || id;

    // Thumbnails: use thumbnails.roblox.com
    let thumbnail = null;
    try {
      const thumbApi = `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&size=420x420&format=png`;
      const thumbs = await fetchJson(thumbApi);
      thumbnail = (thumbs.data && thumbs.data[0] && thumbs.data[0].imageUrl) || null;
    } catch (thumbErr) {
      console.warn('thumb fetch failed', thumbErr.message);
    }

    // Players: games endpoint returns playing counts per universe in some responses.
    const gameDetail = {
      id: universeId,
      name: info.name || info.title || `Game ${id}`,
      creator: info.creator && (info.creator.name || info.creator.Name) || 'Unknown',
      rootPlaceId,
      thumbnail,
      playing: typeof info.playing === 'number' ? info.playing : (info.playingCount || null)
    };

    // Optionally fetch server list to compute live players across servers (can be heavier)
    // const servers = await fetchJson(`https://games.roblox.com/v1/games/${universeId}/servers/Public?limit=100`);
    // sum players from servers if needed.

    res.json(gameDetail);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: /api/users/:id ----------
app.get('/api/users/:id', cache('5 minutes'), async (req, res) => {
  const id = req.params.id;
  try {
    const user = await fetchJson(`https://users.roblox.com/v1/users/${id}`);
    const headshot = await fetchJson(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`);
    const image = (headshot.data && headshot.data[0] && headshot.data[0].imageUrl) || null;
    res.json({
      id: user.id,
      name: user.displayName || user.name,
      created: user.created,
      headshot: image
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Fallback: serve index.html for SPA routes
app.get(['/', '/home', '/signin', '/games', '/users/:id'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Health
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`RLBX server running on port ${PORT}`));
