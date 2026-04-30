import { Router } from "express";
import { getHealthz,getMetadata,pushContext,handleTick,handleReply } from "../controllers/vera.controller.js";


const router = Router()


router.route('/healthz').get(getHealthz)
router.route('/metadata').get(getMetadata)
router.route('/context').post(pushContext)
router.route('/tick').post(handleTick)
router.route('/reply').post(handleReply)






export default router