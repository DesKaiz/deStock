# DepoMap Starter

DepoMap is a starter web app for mapping warehouse locations and manually tracking products. It is an early development scaffold, not a production-ready inventory system.

## Requirements

- Node.js 20.9 or newer
- npm
- A Supabase account/project (optional for the first local map demo; required for shared cloud data)

## Run locally

1. Extract the ZIP.
2. Open the `depomap-starter` folder in VS Code.
3. Open Terminal in that folder.
4. Run:

   ```bash
   npm install
   cp .env.example .env.local
   npm run dev
   ```

   On Windows PowerShell, use `Copy-Item .env.example .env.local` instead of `cp`.
5. Open `http://localhost:3000`.

The map editor currently runs in local demo mode when Supabase environment variables are missing. Demo changes are held in browser memory and will not be shared or persist after refresh. Do not treat demo mode as saved inventory.

## Connect Supabase

1. Create a project at https://supabase.com/.
2. In Project Settings / API (or Connect), copy the Project URL and the publishable/anon key.
3. Put them in `.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. In the Supabase SQL Editor, run `supabase/migrations/0001_initial_schema.sql`.
5. Restart the dev server after changing `.env.local`.

**Never put a Supabase `service_role` or secret key in a `NEXT_PUBLIC_` variable or browser code.** The initial app does not yet implement cloud persistence, authentication, or realtime. Those are the next development steps after the local editor is tested.

## First test checklist

- [ ] The home page opens.
- [ ] Change the warehouse width and length.
- [ ] Add a pallet and move it on the map.
- [ ] Add a rack and select it.
- [ ] Use the product form to add a product to the selected storage object.
- [ ] Confirm the product list updates in the right panel.
- [ ] Refresh the page and observe that demo state resets; this is expected at this stage.

## Current limitations

- No login, invitation flow, RLS policies, cloud save, or cross-device sync yet.
- Map positions use meters and snap to a configurable grid, with Alt-drag allowing free positioning.
- Inventory actions are demo-only until the database functions and authorization rules are implemented.
- Before real users or real inventory, add RLS policies, atomic database RPCs, movement auditing, invitation handling, and tests.
