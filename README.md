# U10 Basketball Rotation Manager

Courtside app for managing player rotations, substitutions, guard matchups,
and court time across a game day. U10 format: 5 on court from a squad of 7
(8 next season), with the game length preset once the season's half length
is known.

**The rotation pattern:** every sub swaps 2 girls. The on-court five is a
window that slides 2 spots around the squad each rotation, so each girl
plays blocks of consecutive rotations rather than bitsy shifts. 5-of-7
never divides evenly inside one game, so the girls who are behind on
minutes for the day are automatically given the higher-minute spots in the
next game — across a day the spread stays within a few minutes.

## Using it on game day

- **▶ Game tab** — start the game, see who's on court, who subs ON/OFF
  next, the since-sub countdown ring, and the game clock vs the preset
  length (with 1st/2nd half shown).
- **Guard matchups** — tap any on-court player to record the opposition
  number she's guarding (🛡 #7). When girls sub off, the OFF chips and the
  next-sub preview show which numbers are freed up so you can reassign
  on the spot.
- **⏸ Pause** — tap the yellow pause button at half time or any stoppage.
  The clock and court-time tracking freeze until you tap ▶ resume. Making
  a sub while paused automatically resumes the clock.
- **■ End game** at the final whistle, then **▶ Set up the next game** —
  the new lineup is auto-balanced from everyone's minutes so far that day.
- **⚙ Setup tab** — the Game Format card (halves × half length, sub
  interval, squad size, players on court), player names, Away/Injured
  availability, and the current game's rotations (tap to swap, hold & drag
  to reorder, ✨ Auto-balance before tip-off).
- **⏱ Time tab** — court time per player, toggled between **this game**
  and the **whole day**, each against its fair-share target, plus a
  rotation log for every game.

Everything auto-saves on the phone. If the app is closed, the phone locks,
or the browser reloads — even between games — the day picks up exactly
where it was, because all times are computed from timestamps.

## Privacy

Player names are never stored in this repository or the published app.
The app only knows players as ids (p1–p8); real names are typed into the
Setup tab and saved in the phone's local browser storage only. Guard
matchup notes live in the same on-device storage.

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
