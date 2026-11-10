const express = require('express');

const app = express();

app.post('/users', (req, res) => res.json({}));
app.put('/users/:id', (req, res) => res.json({}));
app.delete('/users/:id', (req, res) => res.json({}));
app.patch('/users/:id', (req, res) => res.json({}));
app.use('/assets', express.static('public'));

app.listen(3000);
