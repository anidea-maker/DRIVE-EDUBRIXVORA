import { PrismaClient } from '@prisma/client'
import { loadEnvFiles } from './load-env.js'

// Scripts (seeds, smoke tests) import this module directly, so make sure
// `backend/.env` is loaded before the client resolves DATABASE_URL.
loadEnvFiles()

export const prisma = new PrismaClient()
