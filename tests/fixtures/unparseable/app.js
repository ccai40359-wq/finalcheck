const express = require('express');

const app = express();

app.get('/ok', (req, res) => res.json({}));

app.listen(3000);
