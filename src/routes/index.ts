import { Router } from 'express';
import auth from './auth';
import projects from './projects';
import tee from './tee';

const router = Router();

router.use('/', auth);
router.use('/project', projects);
router.use('/tee', tee);

export default router;
