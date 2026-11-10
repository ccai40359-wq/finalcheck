const axios = require('axios');
const API_BASE = 'https://api.internal.example.com';

async function health() {
  const r = await fetch(`${API_BASE}/health`);
  const s = await axios.get('/metrics');
  return [r, s];
}
