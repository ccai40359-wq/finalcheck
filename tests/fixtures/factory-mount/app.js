const express = require('express');
const { makeUsersRouter } = require('./routes/users');

const app = express();

app.use('/users', makeUsersRouter());

app.listen(3000);
