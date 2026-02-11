import { Router } from 'express';
import authRoutes from './auth/routes';
import gameRoutes from './games/routes';
import teamRoutes from './teams/routes';
import leagueRoutes from './leagues/routes';
import seasonRoutes from './seasons/routes';
import playerRoutes from './players/routes';
import invitationRoutes from './invitations/routes';
import statsRoutes from './stats/routes';
import uploadRoutes from './uploads/routes';

const router = Router();

// API routes
router.use('/auth', authRoutes);
router.use('/games', gameRoutes);
router.use('/teams', teamRoutes);
router.use('/leagues', leagueRoutes);
router.use('/seasons', seasonRoutes);
router.use('/players', playerRoutes);
router.use('/invitations', invitationRoutes);
router.use('/stats', statsRoutes);
router.use('/uploads', uploadRoutes);

router.get('/', (_req, res) => {
  res.json({ message: 'API v1' });
});

export default router;

