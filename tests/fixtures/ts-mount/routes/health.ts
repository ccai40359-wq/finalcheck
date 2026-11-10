import { Router } from 'express';

export default function healthRouter(cfg: { version: string }) {
  const r = Router();
  const sessionGuard = (req: unknown, res: unknown, next: () => void) => next();
  r.get('/api/ping', (req, res) => res.json({ ok: true, version: cfg.version }));
  r.get('/api/status', sessionGuard, (req, res) => res.json({ ok: true }));
  return r;
}
