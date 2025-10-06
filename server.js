// server.js
const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for API calls
app.use(cors());

// Serve static files (index.html, logo.png, signin.png, etc.)
app.use(express.static(path.join(__dirname)));

// Serve index.html for root and any page paths
app.get(['/', '/home', '/signin', '/games'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Fetch game info
app.get("/api/games/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const detailsRes = await fetch(`https://games.roblox.com/v1/games?universeIds=${id}`);
    const details = await detailsRes.json();

    const thumbRes = await fetch(
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${id}&size=256x256&format=Png&isCircular=false`
    );
    const thumbs = await thumbRes.json();

    res.json({ details, thumbnails: thumbs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch game data" });
  }
});

// Fetch user profile
app.get("/api/users/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const userRes = await fetch(`https://users.roblox.com/v1/users/${id}`);
    const user = await userRes.json();

    const avatarRes = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`
    );
    const avatar = await avatarRes.json();

    res.json({ user, avatar });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch user data" });
  }
});

app.listen(PORT, () => console.log(`RLBX server running on port ${PORT}`));
