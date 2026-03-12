# WAM Calculator

A Weighted Average Mark (WAM) calculator for Australian university students. Upload your subject outline and instantly see what marks you need to hit your grade target.

## Features

- **Upload your subject outline** — supports PDF, images, text, markdown, and HTML files
- **AI-powered extraction** — automatically parses assessments, weights, and due dates using the Groq API
- **Live WAM calculation** — enter marks as you receive them and see your running WAM update instantly
- **Grade targets** — see exactly what you need to score on remaining assessments to achieve HD, D, CR, or P
- **Hurdle marks** — set a minimum pass mark per assessment; failing a hurdle shows a "Technical Fail" warning regardless of your overall WAM
- **Editable assessments** — adjust max marks, weights, and hurdle thresholds directly in the table
- **Australian grading scale** — HD (85+), D (75+), CR (65+), P (50+), F (<50)

## Tech Stack

- [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [Vite](https://vite.dev/) (v8 beta)
- [PDF.js](https://mozilla.github.io/pdf.js/) — PDF text extraction
- [Groq API](https://groq.com/) — LLM parsing (`llama-3.3-70b-versatile`) and vision fallback (`meta-llama/llama-4-scout-17b-16e-instruct`)

## Getting Started

### Prerequisites

- Node.js 18+
- A free [Groq API key](https://console.groq.com/)

### Installation

```bash
git clone https://github.com/aeomantic/WAM-Calculator.git
cd WAM-Calculator
npm install
```

### Environment Setup

Create a `.env` file in the project root:

```
VITE_GROQ_API_KEY=your_groq_api_key_here
```

### Running Locally

```bash
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173) in your browser.

### Building for Production

```bash
npm run build
```

## Deployment

This project is deployed on [Vercel](https://vercel.com/). To deploy your own instance:

1. Push your code to GitHub
2. Import the repository in Vercel
3. Add `VITE_GROQ_API_KEY` as an environment variable in your Vercel project settings
4. Deploy

## How It Works

1. Upload a PDF or image of your subject outline
2. The app extracts assessment details using PDF.js (text layer) with two AI fallbacks for scanned or complex documents
3. Enter your marks as you receive results
4. The calculator shows your current WAM and the marks needed on incomplete assessments to reach each grade band
5. Set hurdle marks on individual assessments to track technical pass requirements

## License

MIT
