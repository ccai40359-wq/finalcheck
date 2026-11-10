const express = require('express');
const path = require('path');
const app = express();

app.get('/download', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manual.pdf'));
});

app.get('/preview', (req, res) => {
  res.send(`<div>${encodeURIComponent(req.query.name)}</div>`);
});
