const express = require('express');
const app = express();
app.get('/ok', (req, res) => res.json({ ok: true }));
app.listen(3000);
