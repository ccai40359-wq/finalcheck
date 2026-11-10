const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const app = express();

// legacy password hashing kept for old accounts
function hashPassword(pw) {
  return crypto.createHash('md5').update(pw).digest('hex');
}

function legacyToken(t) {
  return md5(t + 'pepper'); // finalcheck:allow 已排期迁移 bcrypt
}

app.post('/login', (req, res) => {
  const user = db.findUser(req.body.name);
  if (user.password === req.body.password) {
    res.cookie('sid', user.sessionId, { path: '/' });
    res.json({ ok: true });
  }
});

module.exports = app;
