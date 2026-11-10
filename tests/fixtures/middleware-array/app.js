const express = require('express');

const mw1 = (req, res, next) => next();
const authBearer = (req, res, next) => next();

const app = express();

app.get('/x', [mw1, authBearer], (req, res) => res.json({}));
app.get('/y', mw1, [authBearer], (req, res) => res.json({}));

app.listen(3000);
