# Kyros Deploy Notes

This is the fast checklist for when `kyros-studio.xyz` looks old, goes black, or does not match the local app.

## Real app path

Always work from the real app:

- `/Users/admin/Downloads/ai-content-studio-saas-main`

Do not confuse it with the old root-level app folders.

## Git repo

Main repo:

- `https://github.com/velinus77/ai-content-studio-saas`

Branch:

- `main`

## Local app launcher

Use the real local launcher:

```bash
/Users/admin/Kyros\ Studio\ Local.command
```

## Before pushing

Build the real client:

```bash
cd /Users/admin/Downloads/ai-content-studio-saas-main
pnpm --dir client run build
```

Restart local app:

```bash
/Users/admin/Kyros\ Studio\ Local.command
```

## Safe push

The git repo root is `/Users/admin/Downloads`, so only add Kyros files explicitly.

Check status:

```bash
cd /Users/admin/Downloads
git status --short -- ai-content-studio-saas-main
```

Push only real app changes:

```bash
cd /Users/admin/Downloads
git add ai-content-studio-saas-main
git commit -m "Describe the Kyros change"
git push origin main
```

## Dokploy app

Server:

- `62.238.10.47`

Dokploy app id:

- `kyros-studio-zeodkp`

Code path on server:

- `/etc/dokploy/applications/kyros-studio-zeodkp/code`

## First checks when website is broken

If the site looks old or black, check these in order:

1. Is the app container healthy?
2. Does the origin app work on port `3001`?
3. Is the public domain pointing to the correct backend?
4. Is the public HTML serving the expected JS bundle?

## Useful server checks

List running containers:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

Check origin directly on server:

```bash
curl -I http://127.0.0.1:3001/
curl -s http://127.0.0.1:3001/ | sed -n '1,40p'
```

Check public site:

```bash
curl -I https://kyros-studio.xyz/
curl -s https://kyros-studio.xyz/ | sed -n '1,40p'
```

## Traefik route file

The important route file is:

- `/etc/dokploy/traefik/dynamic/kyros-studio-zeodkp.yml`

## What broke this time

The app itself was healthy, but the public domain was routed to the wrong backend.

The healthy Kyros app was running on the host at port `3001`, while Traefik was still sending traffic somewhere stale.

That caused:

- old UI
- black page
- public bundle mismatch

## Important live setup reality

Right now there are two Kyros app containers on the Hetzner server:

- `ai-content-studio`
- `kyros-studio-zeodkp...` (Dokploy deployment)

The public site does **not** always follow the newest Dokploy container automatically.

The stable public site path has been:

- Traefik route -> `http://172.17.0.1:3001`
- host port `3001`
- container: `ai-content-studio`

That old stable host app can still be the one serving the public domain even when Dokploy builds a newer app successfully.

## Very important warning

Do **not** switch the public route to the newest Dokploy container just because it is healthy.

Why:

- Dokploy rotates container names and IPs
- Traefik can end up pointing to an old container IP
- that causes `502`
- or the public site changes to a build the user did not want live yet

If the website is already working, assume the live route should stay on the stable host app unless there is a deliberate migration plan.

## Fix that worked

We pointed the live domain route to the healthy host app:

- `http://172.17.0.1:3001`

Then restarted Traefik.

## Current route shape

The service should look like this:

```yaml
http:
  routers:
    kyros-studio-zeodkp-router-1:
      rule: Host(`kyros-studio.xyz`)
      service: kyros-studio-zeodkp-service-1
      middlewares:
        - redirect-to-https
      entryPoints:
        - web
    kyros-studio-zeodkp-router-websecure-1:
      rule: Host(`kyros-studio.xyz`)
      service: kyros-studio-zeodkp-service-1
      middlewares: []
      entryPoints:
        - websecure
      tls:
        certResolver: letsencrypt
  services:
    kyros-studio-zeodkp-service-1:
      loadBalancer:
        servers:
          - url: http://172.17.0.1:3001
        passHostHeader: true
```

Restart Traefik after editing:

```bash
docker restart dokploy-traefik
```

## Safer way to ship a UI/backend update

If the live site is working and you only want to bring over a newer feature, use this order:

1. Build and verify the new app locally.
2. Push to GitHub.
3. Let Dokploy build the new version.
4. Inspect the new Dokploy container, but **do not** switch the public route yet.
5. If needed, copy the specific updated files from the new Dokploy container into the stable live app.
6. Restart only `ai-content-studio`.
7. Verify the public site still returns `200`.

This is what worked for the Vertex/API Keys update:

- kept the website on the old stable route
- copied the newer `client/dist` into `ai-content-studio`
- copied only the needed backend Vertex files into `ai-content-studio`
- restarted `ai-content-studio`

## Files that were manually synced for the Vertex update

- `/app/client/dist`
- `/app/server/config.js`
- `/app/server/routes/keys.js`
- `/app/server/services/apiKeyManager.js`
- `/app/server/services/geminiService.js`
- `/app/server/services/geminiVertexService.js`
- `/app/server/services/geminiBackend.js`

## How to inspect both live paths on the server

List running containers:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

Check the stable host app bundle:

```bash
docker exec ai-content-studio sh -lc "sed -n '1,25p' /app/client/dist/index.html"
```

Check the latest Dokploy app bundle:

```bash
docker exec $(docker ps --format '{{.Names}}' | grep '^kyros-studio-zeodkp.1.' | head -n 1) \
  sh -lc "sed -n '1,25p' /app/client/dist/index.html"
```

Compare the public site bundle:

```bash
curl -s https://kyros-studio.xyz/ | grep -o 'assets/index-[^"]*\.js'
```

## Rule before any future live push

Before changing Traefik or assuming deploy is wrong, answer these:

1. Is the website currently working for clients?
2. Is the stable live app still `ai-content-studio` on host port `3001`?
3. Are we trying to migrate the live route, or just sync a feature?
4. Would copying the feature into the stable app be safer than switching the route?

If the site is already working, prefer syncing the feature into the stable app over changing the live route.

## If local app is correct but website is wrong

That usually means one of these:

- deploy did not rebuild the bundle you think it did
- Traefik is pointing to the wrong backend
- browser cache is showing an older asset

Check the JS asset from both origin and public HTML:

```bash
curl -s http://127.0.0.1:3001/ | grep -o 'assets/index-[^"]*\.js'
curl -s https://kyros-studio.xyz/ | grep -o 'assets/index-[^"]*\.js'
```

Those should match.

## Recovery strategy

If a fresh deploy breaks the site:

1. Roll back to the last stable app bundle.
2. Confirm `http://127.0.0.1:3001` renders.
3. Confirm public HTML matches that origin.
4. Only then try the newer UI again.

## Important reminder

When working locally, do not accidentally include:

- `.agent`
- `.agents`
- `.claude`
- `.codex`
- `build`
- `client/.tmp-tests`
- `client/ios`
- `client/test-results`
- experimental files that are not part of Kyros

Only push the real app.
