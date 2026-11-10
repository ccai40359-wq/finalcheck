const express = require('express');

const app = express();
const api = express.Router();
const users = express.Router();

users.get('/:id', (req, res) => res.json({}));
api.use('/users', users);
app.use('/v1', api);

app.listen(3000);
