const express = require('express');
const { router } = require('./routes/admin');

const app = express();

app.use('/admin', router);

app.listen(3000);
