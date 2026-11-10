const express = require('express');

const app = express();

app.get('/users/:id/posts/:postId', (req, res) => res.json({}));
app.get('/items/:itemId', (req, res) => res.json({}));

app.listen(3000);
