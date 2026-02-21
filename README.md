# AI Content Generation Studio — Phase 1: Backend Core

Local-only Node.js + Express backend with encrypted API key management and Gemini image generation.

## Project Structure

```
ai-content-studio/
├── .env.example
├── .env
├── .gitignore
├── package.json
├── README.md
└── server/
    ├── index.js                  # Express entry point
    ├── middleware/
    │   └── errorHandler.js       # Centralized error handling
    ├── routes/
    │   ├── keys.js               # API key CRUD routes
    │   └── generate.js           # Image generation route
    ├── services/
    │   ├── apiKeyManager.js      # AES-256-GCM encrypted key storage
    │   └── geminiService.js      # Gemini API wrapper
    └── data/
        └── keys.enc              # Encrypted key store (auto-created)
```

## Setup

### 1. Install dependencies

```bash
cd ai-content-studio
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set your `ENCRYPTION_SECRET` (minimum 32 characters). Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Start the server

```bash
npm run dev    # with auto-reload (Node 18+)
# or
npm start      # standard start
```

Server starts at `http://localhost:3001`.

## API Reference

### Health Check

```
GET /api/health
```

### Add API Key

```bash
curl -X POST http://localhost:3001/api/keys \
  -H "Content-Type: application/json" \
  -d '{"name": "My Gemini Key", "apiKey": "AIza..."}'
```

### List Keys (masked)

```bash
curl http://localhost:3001/api/keys
```

### Activate Key

```bash
curl -X PUT http://localhost:3001/api/keys/{id}/activate
```

### Remove Key

```bash
curl -X DELETE http://localhost:3001/api/keys/{id}
```

### Generate Image

```bash
curl -X POST http://localhost:3001/api/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A cat sitting on a rainbow"}'
```

Returns JSON with `data.image.base64Data` (base64-encoded image) and `data.image.mimeType`.

## Security Notes

- API keys are encrypted with AES-256-GCM + PBKDF2 key derivation
- Decrypted keys are never logged or returned in HTTP responses
- CORS restricted to localhost origins only
- All inputs validated before processing
