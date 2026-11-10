const express = require('express');
const userRoutes = require('./routes/users');

const app = express();

app.use('/users', userRoutes);
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(3000);
