# kip

Share a spare room or your whole place with friends — for free — so it doesn't go unused.

kip is a friends-only space-sharing app. You list property you can offer (a room while you're
home, or the whole place while you're away), mark the dates it's free, and friends can book it.
No money changes hands; it's just friends helping friends not waste a good empty bed.

Nobody can find you unless you let them. You're reached by a **username you choose**, or by a
**share link** you send — never by your email or phone, neither of which is ever stored with your
profile. A link works before the person has an account: they can see what's free, and only need to
sign up at the point of asking.

Responsive web client (Next.js, static export) synced via Firestore. Native mobile apps come later.

## Running locally

```bash
cd web
bun install
bun dev
```

The repo ships a populated dev Firebase config (`hafaio-kip-dev`), so `bun dev` gives you the real
sign-in flow (email/password or Google) out of the box. To point at your own project, replace the
`firebaseConfig` in `web/utils/firebase.ts` (see [CLAUDE.md](./CLAUDE.md) for the full setup
walkthrough). Blanking its `appId` disables sign-in for a config-free build.

## License

MIT — see [LICENSE](./LICENSE).
