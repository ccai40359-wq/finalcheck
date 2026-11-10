const express = require('express');

const app = express();

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/private/things', (req, res) => res.json([]));

app.listen(3000);
