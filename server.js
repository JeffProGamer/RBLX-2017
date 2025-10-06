// server.js
// Full OAuth + games + user endpoints for your frontend (no demo).
// Install: npm i express express-session node-fetch apicache express-rate-limit cors jsonwebtoken

const path = require('path');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const apicache = require('apicache');
const cors = require('cors');
const jwt = require('jsonwebtoken');

let fetchLib;
try {
  fetchLib = require('node-fetch');
  fetchLib = fetchLib.default || fetchLib;
} catch (e) {
  if (global.fetch) fetchLib = global.fetch;
  else {
    console.error('Please install node-fetch or run on Node 18+. npm i node-fetch');
    process.exit(1);
  }
}
const fetch = fetchLib;

const app = express();
const cache = apicache.middleware;
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const ROBLOX_CLIENT_ID = process.env.ROBLOX_CLIENT_ID || '';
const ROBLOX_CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me';

if (!ROBLOX_CLIENT_ID || !ROBLOX_CLIENT_SECRET) {
  console.warn('Warning: ROBLOX_CLIENT_ID or ROBLOX_CLIENT_SECRET not set. OAuth will fail until set.');
}

// Allowlist of OAuth candidate endpoints (roblox.com first)
const ENDPOINT_CANDIDATES = {
  authorize: [
    'https://authorize.roblox.com/oauth/authorize',
    'https://www.roblox.com/oauth/authorize',
    'https://apis.roblox.com/oauth/v1/authorize',
  ],
  token: [
    'https://authorize.roblox.com/oauth/token',
    'https://www.roblox.com/oauth/token',
    'https://apis.roblox.com/oauth/v1/token',
  ],
  userinfo: [
    'https://authorize.roblox.com/oauth/v1/userinfo',
    'https://www.roblox.com/oauth/userinfo',
    'https://apis.roblox.com/oauth/v1/userinfo',
  ]
};

// cache resolved endpoints per run
const resolved = {};

function timeoutFetch(url, opts = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

async function probeUrl(url) {
  try {
    const res = await timeoutFetch(url, { method: 'HEAD', redirect: 'manual' }, 3000);
    if (res && res.status && res.status < 500) return true; // reachable
  } catch (e) {
    // HEAD failed, try GET
    try {
      const res2 = await timeoutFetch(url, { method: 'GET', redirect: 'manual' }, 3000);
      if (res2 && res2.status && res2.status < 500) return true;
    } catch (e2) {
      // unreachable
    }
  }
  return false;
}

async function resolveEndpoint(name) {
  // allow environment overrides: OAUTH_AUTHORIZE_URL etc.
  const envKey = name === 'authorize' ? 'OAUTH_AUTHORIZE_URL'
                : name === 'token' ? 'OAUTH_TOKEN_URL'
                : 'OAUTH_USERINFO_URL';
  if (process.env[envKey]) {
    resolved[name] = process.env[envKey];
    console.log(`[oauth] using override ${envKey} -> ${resolved[name]}`);
    return resolved[name];
  }
  if (resolved[name]) return resolved[name];

  const list = ENDPOINT_CANDIDATES[name] || [];
  for (const candidate of list) {
    try {
      const ok = await probeUrl(candidate);
      if (ok) {
        resolved[name] = candidate;
        console.log(`[oauth] resolved ${name} -> ${candidate}`);
        return candidate;
      } else {
        console.warn(`[oauth] probe failed for ${candidate}`);
      }
    } catch (err) {
      console.warn(`[oauth] error probing ${candidate}: ${err.message}`);
    }
  }

  // fallback to first candidate if none probe OK (still return something)
  if (list[0]) {
    resolved[name] = list[0];
    console.warn(`[oauth] none reachable for ${name}; falling back to ${list[0]}`);
    return list[0];
  }

  throw new Error(`No candidates configured for endpoint ${name}`);
}

// helper: GET JSON with timeout + error text
async function fetchJson(url, opts = {}, timeout = 10000) {
  const res = await timeoutFetch(url, opts, timeout);
  if (!res.ok) {
    const txt = await res.text().catch(()=>`status ${res.status}`);
    throw new Error(txt || `HTTP ${res.status}`);
  }
  return res.json();
}

// Express setup
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));
app.use('/api/', rateLimit({ windowMs: 15*1000, max: 40 }));
app.use(express.static(path.join(__dirname)));

// ---------- OAuth start ----------
app.get('/auth', async (req, res) => {
  if (!ROBLOX_CLIENT_ID || !ROBLOX_CLIENT_SECRET) {
    return res.status(500).send('Server not configured: missing client id/secret.');
  }

  const state = Math.random().toString(36).slice(2);
  req.session.oauth_state = state;
  const redirect_uri = `${BASE_URL}/auth/callback`;
  try {
    const authEndpoint = await resolveEndpoint('authorize');
    const scope = encodeURIComponent('openid profile'); // request profile for picture
    // response_type=code for Authorization Code flow
    const url = `${authEndpoint}?client_id=${encodeURIComponent(ROBLOX_CLIENT_ID)}&response_type=code&redirect_uri=${encodeURIComponent(redirect_uri)}&state=${state}&scope=${scope}`;
    console.log('[auth] redirecting to', url);
    return res.redirect(url);
  } catch (err) {
    console.error('[auth] cannot resolve authorize endpoint:', err.message);
    return res.status(500).send('OAuth authorize endpoint not available.');
  }
});

// ---------- OAuth callback (exchange code for token) ----------
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || state !== req.session.oauth_state) {
    return res.status(400).send('Invalid OAuth response (missing code or bad state).');
  }
  const redirect_uri = `${BASE_URL}/auth/callback`;

  try {
    const tokenEndpoint = await resolveEndpoint('token');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri,
      client_id: ROBLOX_CLIENT_ID,
      client_secret: ROBLOX_CLIENT_SECRET
    });

    const tokenRes = await timeoutFetch(tokenEndpoint, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 10000);
    const tokenText = await tokenRes.text();
    if (!tokenRes.ok) {
      console.error('[auth/callback] token exchange failed:', tokenRes.status, tokenText);
      return res.status(500).send('Token exchange failed: ' + tokenText);
    }

    const tokenJson = JSON.parse(tokenText);
    // store tokens in session
    req.session.roblox_token = tokenJson.access_token;
    if (tokenJson.id_token) req.session.roblox_id_token = tokenJson.id_token;
    console.log('[auth/callback] token exchange success; stored tokens in session');
    return res.redirect('/');
  } catch (err) {
    console.error('[auth/callback] error during token exchange:', err);
    return res.status(500).send('OAuth token exchange error: ' + err.message);
  }
});

// ---------- Logout ----------
app.get('/auth/logout', (req, res) => {
  delete req.session.roblox_token;
  delete req.session.roblox_id_token;
  res.redirect('/');
});

// ---------- Get logged-in user (/api/me) ----------
app.get('/api/me', async (req, res) => {
  try {
    if (!req.session.roblox_token && !req.session.roblox_id_token) {
      return res.status(401).json({ error: 'Not signed in' });
    }

    // Try userinfo endpoint first
    let userinfo = null;
    if (req.session.roblox_token) {
      try {
        const userinfoEp = await resolveEndpoint('userinfo');
        const j = await fetchJson(userinfoEp, { headers: { Authorization: `Bearer ${req.session.roblox_token}` } }, 8000);
        userinfo = j;
        console.log('[api/me] used userinfo endpoint:', userinfoEp);
      } catch (e) {
        console.warn('[api/me] userinfo failed:', e.message);
      }
    }

    // Fallback: decode id_token if present
    if (!userinfo && req.session.roblox_id_token) {
      try {
        const decoded = jwt.decode(req.session.roblox_id_token);
        if (decoded) {
          userinfo = decoded;
          console.log('[api/me] used id_token decode fallback');
        }
      } catch (e) {
        console.warn('[api/me] id_token decode failed:', e.message);
      }
    }

    // Last fallback: try users.roblox.com (by calling token owner's user id if available)
    // If we have userinfo.sub (subject) from either earlier method, use thumbnails.
    if (!userinfo) {
      return res.status(500).json({ error: 'Failed to retrieve user info' });
    }

    const userId = userinfo.sub || userinfo.user_id || userinfo.sub?.toString?.();
    let headshot = userinfo.picture || userinfo.image || '';

    if (!headshot && userId) {
      // get thumbnail
      try {
        const th = await fetchJson(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(userId)}&size=48x48&format=Png&isCircular=true`, {}, 8000);
        headshot = th.data?.[0]?.imageUrl || '';
        console.log('[api/me] fetched headshot via thumbnails.roblox.com');
      } catch (e) {
        console.warn('[api/me] thumbnails fetch failed:', e.message);
      }
    }

    const name = userinfo.name || userinfo.nickname || userinfo.preferred_username || userinfo.displayName || userinfo.username || 'Unknown';
    res.json({ id: userId, name, headshot });
  } catch (err) {
    console.error('[api/me] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Games API (/api/games) ----------
app.get('/api/games', cache('30 seconds'), async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const q = (req.query.query || '').trim();

  try {
    let games = [];

    // 1) Try games list/search endpoint (commonly games.roblox.com/v1/games/list)
    try {
      const listUrl = `https://games.roblox.com/v1/games/list?keyword=${encodeURIComponent(q)}&limit=${limit}`;
      const r = await fetchJson(listUrl, {}, 9000);
      if (Array.isArray(r.data) && r.data.length) {
        games = r.data.map(g => ({
          id: g.id || g.universeId || g.placeId || g.assetId,
          name: g.name || g.title || '',
          creator: (g.creator && g.creator.name) || g.creatorName || 'Unknown',
          thumbnail: g.iconUrl || g.thumbnailUrl || null,
          playing: g.playing || g.currentPlayers || null,
          visits: g.visits || null
        }));
        console.log('[api/games] used games/list');
      }
    } catch (e) {
      console.warn('[api/games] games/list failed:', e.message);
    }

    // 2) If no results, try sorts + games with sortToken (top lists)
    if (!games.length) {
      try {
        const sorts = await fetchJson('https://games.roblox.com/v1/games/sorts?model.gameSortsContext=GamesDefaultSorts', {}, 7000);
        const token = sorts?.sorts?.[0]?.token;
        if (token) {
          const list = await fetchJson(`https://games.roblox.com/v1/games?sortToken=${encodeURIComponent(token)}&limit=${limit}`, {}, 9000);
          if (Array.isArray(list.data) && list.data.length) {
            games = list.data.map(g => ({
              id: g.id || g.universeId,
              name: g.name,
              creator: g.creator?.name || 'Unknown',
              thumbnail: g.iconUrl || null,
              playing: g.playing || null,
              visits: g.visits || null
            }));
            console.log('[api/games] used games/sorts -> games');
          }
        }
      } catch (e) {
        console.warn('[api/games] sorts/games failed:', e.message);
      }
    }

    // 3) If still empty and query is numeric (a placeId), try multiget-place-details -> universe -> games?universeIds=
    if (!games.length && q && /^\d+$/.test(q)) {
      try {
        const placeId = q;
        const details = await fetchJson(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${encodeURIComponent(placeId)}`, {}, 8000);
        if (Array.isArray(details) && details.length) {
          const place = details[0];
          if (place && place.universeId) {
            const byUniverse = await fetchJson(`https://games.roblox.com/v1/games?universeIds=${encodeURIComponent(place.universeId)}`, {}, 8000);
            if (Array.isArray(byUniverse.data) && byUniverse.data.length) {
              games = byUniverse.data.map(g => ({
                id: g.id,
                name: g.name,
                creator: g.creator?.name || 'Unknown',
                thumbnail: g.iconUrl || null,
                playing: g.playing || null,
                visits: g.visits || null
              }));
              console.log('[api/games] used multiget-place-details -> games?universeIds');
            }
          }
        }
      } catch (e) {
        console.warn('[api/games] place-details fallback failed:', e.message);
      }
    }

    // respond
    return res.json({ query: q, limit, data: games });
  } catch (err) {
    console.error('[api/games] error:', err);
    return res.status(500).json({ query: q, limit, data: [], error: err.message });
  }
});

// Serve SPA (index.html must exist in project root)
app.get(['/', '/home', '/signin', '/games', '/settings', '/terms', '/privacy'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`RLBX server running on port ${PORT} (BASE_URL=${BASE_URL})`));
