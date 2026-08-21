# U8 Basketball Rotation Manager

Courtside app for managing player rotations, substitutions, and court time
across a round-robin tournament day: 4× 8-minute games (plus a final if
they make it), 8 players, 4 on court.

**The rotation pattern:** every sub swaps exactly 2 girls. The squad is
split into 4 pairs and each rotation has two pairs on court, laddering
every 2 minutes — so each girl plays a continuous 4-minute block per game
(two rotations back to back) and everyone lands on 4:00 per game, 16:00
across the round robin. The one pair whose block wraps around the
first/last rotation changes each game, so that evens out over the day too.

## Using it on game day

- **▶ Game tab** — start the game, see who's on court, who subs ON/OFF next,
  a 2-minute countdown ring since the last sub, and the ~8:00 game clock.
- **⏸ Pause** — tap the yellow pause button at any stoppage. The clock and
  court-time tracking freeze until you tap ▶ resume. Making a sub while
  paused automatically resumes the clock.
- **■ End game** at the final whistle, then **▶ Set up the next game** —
  the new lineup is auto-balanced from everyone's minutes so far that day,
  which matters most when a girl is away or injured for part of the day.
- **⚙ Setup tab** — player names, mark girls Away/Injured (removed from all
  rotations), edit the current game's rotations (tap to swap, hold & drag
  to reorder), or ✨ Auto-balance before tip-off.
- **⏱ Time tab** — court time per player, toggled between **this game**
  (vs 4:00) and the **whole day** (vs 4:00 × games played), plus a rotation
  log for every game.

Everything auto-saves on the phone. If the app is closed, the phone locks,
or the browser reloads — even between games — the day picks up exactly
where it was, because all times are computed from timestamps.

## Privacy

Player names are never stored in this repository or the published app.
The app only knows players as ids (p1–p8); real names are typed into the
Setup tab and saved in the phone's local browser storage only.

## Development

```
npm install
npm run dev      # local dev server
npm run build    # produces docs/index.html — a single self-contained file
```

The build is one standalone HTML file served by GitHub Pages from `docs/`:

**https://claydu.github.io/rotation-manager/**

To ship a change: `npm run build`, commit, push to `master` — Pages
redeploys automatically. On a phone, open the URL in the browser and
"Add to Home Screen" for an app-like experience.
