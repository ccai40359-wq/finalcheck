import express from 'express';
import healthRouter from './routes/health.js';

const app = express();

app.use(healthRouter({ version: '1.0.0' }));

app.listen(3000);
