const express = require('express');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const loadUser = async (req, res, next) => {
  next();
};

const app = express();

app.get('/data', async (req, res, next) => {
  next();
}, (req, res) => res.json({}));
app.get('/profile', asyncHandler(loadUser), (req, res) => res.json({}));
app.get('/settings', loadUser, (req, res) => res.json({}));

app.listen(3000);
