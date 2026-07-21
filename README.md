# Apprenticeship AI Assistant

AI-powered apprenticeship search and notification tool.

## Quick Start

```bash
npm start        # start the server on http://localhost:3000
npm test         # run the test suite
```

## Project Structure

```
apprenticeship-ai-assistant/
├── server.js              # Node.js HTTP server (built-in modules only)
├── public/
│   ├── index.html         # Main UI
│   ├── styles.css         # Styling
│   └── app.js             # Client-side logic
├── data/
│   └── opportunities.json # Search results (initially empty)
├── tests/
│   └── app.test.js        # Node.js built-in test runner
├── .env.example           # Environment variable template
├── .gitignore
└── README.md
```

## API Endpoints

| Method | Path               | Description              |
|--------|--------------------|--------------------------|
| GET    | `/api/health`      | Health check             |
| GET    | `/api/opportunities` | Current opportunities  |

## License

UNLICENSED — private project.
