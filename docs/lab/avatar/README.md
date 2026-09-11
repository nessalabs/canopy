# Agent avatar lab

A standalone bench for the agent avatar (`packages/ui/src/components/agent/agent-avatar.tsx`):
nessa's `RandomAvatar` in its working state as each activity tunes it, the `flood` / `speed` /
`bleed` rows from nessa's own Tuning story, sliders for dialling a combination in at every
transcript size, and the paint-on bloom. It needs no daemon and was never part of the build.

Parked here, out of the app, on 2026-09-11. To bring it back:

```sh
cp docs/lab/avatar/lab.html apps/web/lab.html
cp docs/lab/avatar/lab.tsx  apps/web/src/lab.tsx
mkdir -p packages/ui/src/lab && cp docs/lab/avatar/avatar-lab.tsx packages/ui/src/lab/avatar-lab.tsx
```

then add `"./lab/avatar": "./src/lab/avatar-lab.tsx"` to `exports` in `packages/ui/package.json`
and `"@canopy/ui/lab/avatar": ["../../packages/ui/src/lab/avatar-lab.tsx"]` to `paths` in
`apps/web/tsconfig.json`. The web client's dev server then serves it at `/lab.html`.
