import dotenv from 'dotenv'
import bcrypt from 'bcryptjs'
import cors from 'cors'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import rateLimit from 'express-rate-limit'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, unlink } from 'node:fs'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import multer from 'multer'

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '.env') })

const app = express()
const port = process.env.PORT || 5000
const jwtSecret = process.env.JWT_SECRET || 'development-secret-change-me'
const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mise-en-place'
let mongoConnectionError = null
const serverDirectory = dirname(fileURLToPath(import.meta.url))
const uploadsDirectory = resolve(serverDirectory, 'uploads', 'cooking-results')
mkdirSync(uploadsDirectory, { recursive: true })
const deleteFile = promisify(unlink)
const cookingPhotoUpload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, uploadsDirectory),
    filename: (_request, file, callback) => callback(null, `${randomUUID()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return callback(new Error('Choose a JPG, PNG, or WEBP photo'))
    callback(null, true)
  },
})

app.use(cors())
app.use(express.json())
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }))
app.use('/uploads', express.static(resolve(serverDirectory, 'uploads'), { maxAge: '1d' }))

const recipeSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: String,
  category: String,
  cuisine: String,
  difficulty: String,
  preparationTime: Number,
  cookingTime: Number,
  servings: Number,
  coverImage: String,
  gallery: [String],
  videos: [String],
  ingredients: [{ name: String, quantity: String, unit: String }],
  steps: [{ description: String, timer: Number }],
  tags: [String],
  nutrition: { calories: Number, protein: Number, carbohydrates: Number, fat: Number, sugar: Number, sodium: Number },
  status: { type: String, enum: ['draft', 'published'], default: 'published' },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  likes: { type: Number, default: 0 },
  views: { type: Number, default: 0 },
  averageRating: { type: Number, default: 0 },
}, { timestamps: true })

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true, select: false },
  bio: String,
  country: String,
  favoriteFoods: [String],
  profilePicture: String,
  followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
}, { timestamps: true })

const cookingSessionSchema = new mongoose.Schema({
  recipe: { type: mongoose.Schema.Types.ObjectId, ref: 'Recipe', required: true, index: true },
  cookedAt: { type: Date, default: Date.now, index: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  notes: { type: String, trim: true, maxlength: 3000, default: '' },
  resultPhoto: { type: String, default: '' },
}, { timestamps: true })

const Recipe = mongoose.model('Recipe', recipeSchema)
const User = mongoose.model('User', userSchema)
const CookingSession = mongoose.model('CookingSession', cookingSessionSchema)

const auth = (request, response, next) => {
  const token = request.headers.authorization?.replace('Bearer ', '')
  if (!token) return response.status(401).json({ message: 'Authentication required' })
  try { request.user = jwt.verify(token, jwtSecret); next() } catch { response.status(401).json({ message: 'Invalid or expired token' }) }
}
const requireDatabase = (_request, response, next) => mongoose.connection.readyState === 1 ? next() : response.status(503).json({ message: 'MongoDB is not connected' })
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const parsePage = (value) => Math.max(1, Number.parseInt(value, 10) || 1)
const parseLimit = (value) => Math.min(50, Math.max(1, Number.parseInt(value, 10) || 12))

app.get('/api/health', (_request, response) => response.json({
  status: 'ok',
  database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  databaseError: mongoConnectionError,
  databaseConfig: process.env.MONGO_URI ? 'MONGO_URI' : 'local default',
}))
app.get('/api/recipes', requireDatabase, async (request, response) => {
  const { search, category, cuisine, difficulty, status = 'published' } = request.query
  const page = parsePage(request.query.page)
  const limit = parseLimit(request.query.limit)
  const filter = {}
  if (category) filter.category = category
  if (cuisine) filter.cuisine = cuisine
  if (difficulty) filter.difficulty = difficulty
  if (status !== 'all') filter.status = status
  if (search) filter.$or = [{ title: new RegExp(escapeRegex(search), 'i') }, { tags: new RegExp(escapeRegex(search), 'i') }, { cuisine: new RegExp(escapeRegex(search), 'i') }]
  const recipes = await Recipe.find(filter).populate('author', 'name username profilePicture').skip((page - 1) * limit).limit(Number(limit)).sort({ createdAt: -1 })
  const total = await Recipe.countDocuments(filter)
  response.json({ recipes, page: Number(page), pages: Math.ceil(total / limit), total })
})
app.get('/api/recipes/:id', requireDatabase, async (request, response) => {
  const recipe = await Recipe.findByIdAndUpdate(request.params.id, { $inc: { views: 1 } }, { new: true }).populate('author', 'name username bio profilePicture')
  if (!recipe) return response.status(404).json({ message: 'Recipe not found' })
  response.json(recipe)
})
app.get('/api/recipes/:id/cooking-sessions', requireDatabase, async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) return response.status(400).json({ message: 'Invalid recipe id' })
  const sessions = await CookingSession.find({ recipe: request.params.id }).sort({ cookedAt: -1 }).limit(100)
  response.json({ sessions })
})
app.post('/api/recipes/:id/cooking-sessions', requireDatabase, cookingPhotoUpload.single('resultPhoto'), async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id)) {
    if (request.file) await deleteFile(request.file.path).catch(() => {})
    return response.status(400).json({ message: 'Invalid recipe id' })
  }
  if (!await Recipe.exists({ _id: request.params.id })) {
    if (request.file) await deleteFile(request.file.path).catch(() => {})
    return response.status(404).json({ message: 'Recipe not found' })
  }
  const rating = Number(request.body.rating)
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    if (request.file) await deleteFile(request.file.path).catch(() => {})
    return response.status(400).json({ message: 'Rating must be from 1 to 5' })
  }
  let session
  try {
    session = await CookingSession.create({
      recipe: request.params.id,
      cookedAt: request.body.cookedAt || Date.now(),
      rating,
      notes: request.body.notes || '',
      resultPhoto: request.file ? `/uploads/cooking-results/${request.file.filename}` : '',
    })
  } catch (error) {
    if (request.file) await deleteFile(request.file.path).catch(() => {})
    throw error
  }
  response.status(201).json(session)
})
app.post('/api/recipes', requireDatabase, async (request, response) => {
  if (!request.body.title?.trim()) return response.status(400).json({ message: 'Recipe title is required' })
  const recipe = await Recipe.create({ ...request.body, title: request.body.title.trim(), author: request.user?.id || undefined })
  response.status(201).json(recipe)
})
app.put('/api/recipes/:id', requireDatabase, async (request, response) => {
  const recipe = await Recipe.findByIdAndUpdate(request.params.id, { ...request.body, author: undefined }, { new: true, runValidators: true })
  if (!recipe) return response.status(404).json({ message: 'Recipe not found' })
  response.json(recipe)
})
app.delete('/api/recipes/:id', requireDatabase, async (request, response) => {
  const recipe = await Recipe.findByIdAndDelete(request.params.id)
  if (!recipe) return response.status(404).json({ message: 'Recipe not found' })
  response.status(204).end()
})
app.post('/api/auth/register', requireDatabase, async (request, response) => {
  const { name, username, email, password } = request.body
  const user = await User.create({ name, username, email, password: await bcrypt.hash(password, 12) })
  response.status(201).json({ user: { id: user.id, name: user.name, username: user.username }, token: jwt.sign({ id: user.id }, jwtSecret, { expiresIn: '7d' }) })
})
app.post('/api/auth/login', requireDatabase, async (request, response) => {
  const { email, password } = request.body
  const user = await User.findOne({ email }).select('+password')
  if (!user || !(await bcrypt.compare(password, user.password))) return response.status(401).json({ message: 'Email or password is incorrect' })
  response.json({ user: { id: user.id, name: user.name, username: user.username }, token: jwt.sign({ id: user.id }, jwtSecret, { expiresIn: '7d' }) })
})
app.get('/api/profile', auth, requireDatabase, async (request, response) => {
  response.json(await User.findById(request.user.id).select('-password'))
})
app.put('/api/profile', auth, requireDatabase, async (request, response) => {
  const user = await User.findByIdAndUpdate(request.user.id, request.body, { new: true, runValidators: true }).select('-password')
  response.json(user)
})

mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 8000 })
  .then(() => {
    mongoConnectionError = null
    console.log('MongoDB connected')
  })
  .catch((error) => {
    mongoConnectionError = error.code || error.name || 'ConnectionError'
    console.error(`MongoDB connection failed (${mongoConnectionError}). Check server/.env and confirm MongoDB is running or the Atlas IP is allowlisted.`)
  })
mongoose.connection.on('error', (error) => {
  mongoConnectionError = error.code || error.name || 'ConnectionError'
  console.error(`MongoDB connection error (${mongoConnectionError})`)
})
app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError || error.message === 'Choose a JPG, PNG, or WEBP photo') {
    return response.status(400).json({ message: error.message === 'LIMIT_FILE_SIZE' ? 'Photo must be 8 MB or smaller' : error.message })
  }
  if (error?.code === 11000) return response.status(409).json({ message: 'That username or email is already in use' })
  if (error?.name === 'ValidationError') return response.status(400).json({ message: Object.values(error.errors).map((item) => item.message).join(', ') })
  console.error(error)
  response.status(500).json({ message: 'Something went wrong on the server' })
})
app.listen(port, () => console.log(`API listening on http://localhost:${port}`))
