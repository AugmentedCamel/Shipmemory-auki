import { Router } from 'express';
import { AukiAuthService } from '../services/AukiAuthService.js';

export const authRoutes = Router();

/** POST /auth/login — Proxy login to Auki, return tokens to client */
authRoutes.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: 'email and password required' });
      return;
    }
    const tokens = await AukiAuthService.login(email, password);
    res.json(tokens);
  } catch (err: any) {
    const status = err?.response?.status || 500;
    res.status(status).json({ error: 'Login failed', detail: err?.message });
  }
});
