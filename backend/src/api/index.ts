import { Router } from 'express';
import authRoutes from './auth/routes';
import gameRoutes from './games/routes';
import teamRoutes from './teams/routes';
import leagueRoutes from './leagues/routes';
import playerRoutes from './players/routes';

const router = Router();

// API routes
router.use('/auth', authRoutes);
router.use('/games', gameRoutes);
router.use('/teams', teamRoutes);
router.use('/leagues', leagueRoutes);
router.use('/players', playerRoutes);

router.get('/', (_req, res) => {
  res.json({ message: 'API v1' });
});

export default router;

