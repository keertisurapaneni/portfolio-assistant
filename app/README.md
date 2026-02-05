# Portfolio Assistant

A personal investing decision-support tool for tracking stock portfolios with automated conviction scoring, risk monitoring, and curated discovery.

## Tech Stack

- **Frontend:** React 18 + TypeScript + Vite
- **Styling:** Tailwind CSS 4 + shadcn/ui
- **Backend:** Supabase (PostgreSQL + Auth + Edge Functions)
- **Deployment:** Vercel (Frontend) + Supabase (Backend)
- **APIs:** Finnhub (stock data)

## Environment Setup

### Prerequisites

- Node.js 18.x or 20.x (LTS recommended)
- npm or yarn package manager
- Supabase account (for cloud features)
- Finnhub API key (free tier available)

### Local Development Setup

1. **Clone the repository** (when using git later)

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Configure environment variables:**

   Copy the example environment file:

   ```bash
   cp .env.example .env
   ```

4. **Set up API keys in `.env`:**

   **Finnhub API Key** (Required for stock data):
   - Sign up at: https://finnhub.io/register
   - Copy your API key
   - Update `.env`: `VITE_FINNHUB_API_KEY=your_actual_key`

   **Supabase Configuration** (Required for multi-user features):
   - Create a project at: https://app.supabase.com
   - Go to Project Settings → API
   - Copy the Project URL and anon/public key
   - Update `.env`:
     ```
     VITE_SUPABASE_URL=https://your-project-id.supabase.co
     VITE_SUPABASE_ANON_KEY=your_actual_anon_key
     ```

   **Note:** The app will work in **guest mode** without Supabase (using localStorage). Cloud features (authentication, multi-device sync) require Supabase to be configured (Story 5.1). Until then, leave the placeholder values as-is.

5. **Run the development server:**

   ```bash
   npm run dev
   ```

   Open http://localhost:5173 in your browser.

### Environment Variables Reference

| Variable                 | Description                    | Required             | Where to Get                        |
| ------------------------ | ------------------------------ | -------------------- | ----------------------------------- |
| `VITE_FINNHUB_API_KEY`   | Finnhub API key for stock data | Yes                  | https://finnhub.io/register         |
| `VITE_SUPABASE_URL`      | Supabase project URL           | Yes (for auth/cloud) | Supabase Dashboard → Settings → API |
| `VITE_SUPABASE_ANON_KEY` | Supabase anonymous/public key  | Yes (for auth/cloud) | Supabase Dashboard → Settings → API |

**Important Security Notes:**

- ✅ `.env` is gitignored - your secrets are safe
- ✅ `VITE_SUPABASE_ANON_KEY` is safe to use in client code (Row Level Security protects data)
- ⚠️ Never commit `.env` file or share your API keys publicly
- ⚠️ Never use Supabase `service_role` key in client code
- 🔄 **If you accidentally commit secrets:** Immediately revoke and rotate your API keys (Finnhub dashboard, Supabase dashboard)

**Local Development vs Production:**

- `.env` is for **local development only** - these variables are loaded by Vite during `npm run dev`
- **Production (Vercel):** Environment variables are set in Vercel Dashboard → Project Settings → Environment Variables
- The same variable names are used in both environments, but values are managed separately
- Never commit `.env` to git - each environment has its own configuration

### Supabase Edge Function Secrets

When deploying the Supabase Edge Function (Story 2.1), you'll need to set the Finnhub API key as a Supabase secret.

**Prerequisites:**

1. Supabase CLI installed: `npm install -g supabase`
2. Supabase project created (see configuration step above)
3. Supabase CLI authenticated: `supabase login`
4. Project linked: `supabase link --project-ref your-project-ref`

**Set Edge Function Secret:**

```bash
# Set Edge Function secret (keeps API key secure on server)
supabase secrets set FINNHUB_API_KEY=your_finnhub_api_key_here
```

This keeps the API key secure on the server side and enables shared caching for all users.

## Troubleshooting

### Common Setup Issues

**Port 5173 already in use:**

```bash
# Kill process on port 5173
lsof -ti:5173 | xargs kill -9

# Or run on a different port
npm run dev -- --port 3000
```

**Environment variables not loading:**

- Verify `.env` file exists in `/app` directory (not project root)
- Check that variable names start with `VITE_` prefix
- Restart dev server after changing `.env`
- Try: `cat .env` to verify file contents

**API key errors (401 Unauthorized):**

- Verify Finnhub API key is valid at https://finnhub.io/dashboard
- Check for extra spaces or quotes in `.env` file
- Ensure `VITE_FINNHUB_API_KEY` is set correctly

**Supabase connection errors:**

- Verify project URL and anon key are correct
- Check Supabase project status at https://app.supabase.com
- If not using auth yet, the app should work in guest mode (localStorage)

**Build errors:**

- Clear node_modules and reinstall: `rm -rf node_modules && npm install`
- Clear Vite cache: `rm -rf node_modules/.vite`
- Check Node.js version: `node -v` (should be 18.x or 20.x)

**"Cannot find module" errors:**

- Ensure all dependencies installed: `npm install`
- Check TypeScript paths in `tsconfig.json`

### Getting Help

If you encounter issues not covered here:

1. Check browser console for error messages (F12 → Console)
2. Check terminal for build/server errors
3. Verify all environment variables are set correctly
4. Try restarting the dev server

## Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build locally
- `npm run lint` - Run ESLint

## Guest vs Authenticated Modes

**Guest Mode (Default):**

- No login required
- Data saved in browser localStorage
- Full functionality available
- Data persists in browser only

**Authenticated Mode (Optional):**

- Sign up with email/password
- Portfolio synced to cloud (Supabase)
- Access from any device
- Guest data automatically migrated on signup

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type aware lint rules:

- Configure the top-level `parserOptions` property like this:

```js
export default tseslint.config({
  languageOptions: {
    // other options...
    parserOptions: {
      project: ['./tsconfig.node.json', './tsconfig.app.json'],
      tsconfigRootDir: import.meta.dirname,
    },
  },
});
```

- Replace `tseslint.configs.recommended` to `tseslint.configs.recommendedTypeChecked` or `tseslint.configs.strictTypeChecked`
- Optionally add `...tseslint.configs.stylisticTypeChecked`
- Install [eslint-plugin-react](https://github.com/jsx-eslint/eslint-plugin-react) and update the config:

```js
// eslint.config.js
import react from 'eslint-plugin-react';

export default tseslint.config({
  // Set the react version
  settings: { react: { version: '18.3' } },
  plugins: {
    // Add the react plugin
    react,
  },
  rules: {
    // other rules...
    // Enable its recommended rules
    ...react.configs.recommended.rules,
    ...react.configs['jsx-runtime'].rules,
  },
});
```
