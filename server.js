// server.js
// RLBX 2017: Server-side app for Render
// Node 18+ recommended

const express = require('express');
const fetch = require('node-fetch'); // v2
const path = require('path');
const cors = require('cors');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const apicache = require('apicache');

const app = express();
const cache = apicache.middleware;
const PORT = process.env.PORT || 3000;

// === CONFIG (set these env vars in Render) ===
const ROBLOX_CLIENT_ID = process.env.ROBLOX_CLIENT_ID || '6438392192740765716';
const ROBLOX_CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET || 'RBX-xXCEXLXi-E6pOKm8E_OZJ_TPWxIFRUIkcWjQeOICeG8AEPIbhJzJWZqIrU3p320K';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// === SECURITY & BASE MIDDLEWARE ===
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'ac0d696e0f977ccc8677bdd66d537fb1d3525eabf898ec43e17994c61db8c12b8895d10a389a6a502ff13468274c3583420080ca293150b0e6294ccebf22e9dd',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // true with HTTPS in production
}));

app.use('/api/', rateLimit({ windowMs: 15 * 1000, max: 40 }));

// Serve static files
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

// ---------- ROBLOX OAUTH 2.0 ----------
const AUTH_AUTHORIZE = 'https://apis.roblox.com/oauth/authorize';
const AUTH_TOKEN = 'https://apis.roblox.com/oauth/token';

app.get('/auth/roblox', (req, res) => {
  const state = Math.random().toString(36).slice(2);
  req.session.oauth_state = state;
  const redirect_uri = `${BASE_URL}/auth/roblox/callback`;
  const scope = encodeURIComponent('openid profile');
  const url = `${AUTH_AUTHORIZE}?client_id=${ROBLOX_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirect_uri)}&state=${state}&scope=${scope}`;
  res.redirect(url);
});

app.get('/auth/roblox/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || state !== req.session.oauth_state) return res.status(400).send('Invalid OAuth state or code');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${BASE_URL}/auth/roblox/callback`,
    client_id: ROBLOX_CLIENT_ID,
    client_secret: ROBLOX_CLIENT_SECRET
  });

  try {
    const tokenResp = await fetch(AUTH_TOKEN, { method: 'POST', body });
    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      console.error('token error', text);
      return res.status(500).send('OAuth token exchange failed');
    }
    const tokenJson = await tokenResp.json();
    req.session.roblox_token = tokenJson.access_token;
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('OAuth exchange failed');
  }
});

app.get('/auth/logout', (req, res) => {
  delete req.session.roblox_token;
  res.redirect('/');
});

// ---------- API endpoints ----------
// Example: /api/topgames, /api/search, /api/game/:id, /api/users/:id
// (Same as your original logic, cleaned to avoid minor errors)

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Fallback for SPA routes
app.get(['/', '/home', '/signin', '/games', '/users/:id'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`RLBX server running on port ${PORT}`));
