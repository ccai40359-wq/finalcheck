import express from 'express';
import apiRouter from './api.js';

const app = express();

app.use('/api', apiRouter);

app.listen(3000);
