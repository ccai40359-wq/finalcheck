const express = require('express');

const app = express();

app.get('/ping', function handler(req, res) {
  res.json({ ok: true });
});

app.listen(3000);
