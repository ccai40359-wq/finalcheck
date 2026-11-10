const express = require('express');

const auth = (req, res, next) => next();

const app = express();

app.get('/me', auth, (req, res) => res.json({ user: 'me' }));

app.listen(3000);
