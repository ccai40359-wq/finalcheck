const express = require('express');
const app = express();

app.get('/download', (req, res) => {
  res.sendFile('/data/attachments/' + req.params.name);
});

app.get('/preview', (req, res) => {
  res.send(`<div class="preview">${req.query.html}</div>`);
});
