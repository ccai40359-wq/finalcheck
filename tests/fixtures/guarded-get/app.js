const express = require('express');

const auth = (req, res, next) => req.user ? next() : res.sendStatus(401);

const app = express();

app.get('/me', auth, (req, res) => res.json({ user: 'me' }));

app.listen(3000);
