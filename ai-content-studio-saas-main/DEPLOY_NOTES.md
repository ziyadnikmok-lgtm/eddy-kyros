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
