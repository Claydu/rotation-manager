# U8 Basketball Rotation Manager

Courtside app for managing player rotations, substitutions, and court time
for a U8 basketball team. 8 players, 4 on court, sub 2 every 5 minutes —
everyone gets 15 minutes across a 30-minute game.

## Using it on game day

- **▶ Game tab** — start the game, see who's on court, who subs ON/OFF next,
  and a 5-minute countdown ring since the last sub.
- **⏸ Pause** — tap the yellow pause button at half time (or any stoppage).
  The clock and court-time tracking freeze until you tap ▶ resume.
  Making a sub while paused automatically resumes the clock.
- **⚙ Setup tab** — mark girls Away/Injured (removed from all rotations),
  reorder rotations, or tap a player to swap her for someone else.
- **⏱ Time tab** — live court time per player vs the 15:00 target, plus a
  log of how long each rotation actually ran.

Everything auto-saves on the phone. If the app is closed, the phone locks,
or the browser reloads, the game picks up exactly where it was — including
the running clock, because all times are computed from timestamps.

## Development

```
npm install
npm run dev      # local dev server
npm run build    # produces dist/index.html — a single self-contained file
```

The build is one standalone HTML file. Share it however you like (email,
AirDrop, host it anywhere) — it needs no server, no account, no internet.
On a phone, open it in the browser and "Add to Home Screen" for an app-like
experience.
