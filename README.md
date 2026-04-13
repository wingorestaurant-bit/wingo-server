# Wing-O Online Ordering Server

Backend server that relays online orders to Clover POS — solves the CORS issue.

## What this does
- Customer orders on the website
- Website calls THIS server (not Clover directly)
- This server calls Clover API securely
- Order appears on your Clover terminal at Albert Street

## HOW TO DEPLOY (Free — takes 10 minutes)

### Step 1 — Create GitHub account (if you don't have one)
Go to github.com → Sign Up (free)

### Step 2 — Upload this folder to GitHub
1. Go to github.com → click "New repository"
2. Name it: wingo-server
3. Click "Create repository"
4. Upload all files in this folder

### Step 3 — Deploy on Railway (free hosting)
1. Go to railway.app → Sign in with GitHub
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your "wingo-server" repo
4. Railway auto-detects Node.js and deploys it
5. Click "Generate Domain" → you get a URL like:
   https://wingo-server-production.up.railway.app

### Step 4 — Update the website
In index.html, find this line:
  const API_BASE = ...
Change the Railway URL to your actual URL.

### Step 5 — Test
Visit: https://your-url.up.railway.app/api/health
Should show: {"status":"ok","locations":["albert-st"]}

## Adding More Locations
In server.js, find the LOCATIONS object and add:
```
"moose-jaw": {
  name: "Moose Jaw",
  merchantId: "YOUR_MERCHANT_ID",
  apiToken: "YOUR_API_TOKEN",
  address: "Your address",
  phone: "Your phone",
  hours: "Your hours"
}
```

## Files
- server.js — the backend (talks to Clover)
- public/index.html — the website
- package.json — Node.js config
