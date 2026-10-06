# U10 Basketball Rotation Manager

Courtside app for managing player rotations, substitutions, guard matchups,
and court time across a game day. U10 format: 5 on court from a squad of 7
(8 next season), with the game length preset once the season's half length
is known.

**The rotation pattern:** every sub swaps 2 girls. The on-court five is a
window that slides 2 spots around the squad each rotation, so each girl
plays blocks of consecutive rotations rather than bitsy shifts. Equal time
is aimed at **within each game only** — every game starts fresh and
nothing carries over between games. 5-of-7 never divides perfectly inside
one game, so which girls land on the slightly longer end rotates from game
to game. Girls marked **😴 Tired** still play but get the lighter
rotations that day — fatigue management is the coach's call, not a debt
the balancer repays later.

## Using it on game day

- **▶ Game tab** — start the game, see who's on court, who subs ON/OFF
  next, the since-sub countdown ring, and the game clock vs the preset
  length (with 1st/2nd half shown).
- **Guard matchups** — tap any on-court player to record the opposition
  number she's guarding (🛡 #7). When girls sub off, the OFF chips and the
  next-sub preview show which numbers are freed up so you can reassign
  on the spot.
- **⏸ Pause** — tap the yellow pause button at any stoppage. The clock and
  court-time tracking freeze until you tap ▶ resume. Making a sub while
  paused automatically resumes the clock. **Half time and full time pause
  themselves**: when the game clock crosses a break or the full game
  length the clock stops automatically, and the banner says whether to
  tap ▶ for the restart or ■ to end the game — a forgotten clock can no
  longer inflate court times. If one still over-runs, a **✂ Trim
  over-run** button on that game's rotation log (Time tab) retroactively
  ends it at full time and removes the excess from everyone's stats.
- **■ End game** at the final whistle, then **▶ Set up the next game** —
  a fresh auto-balanced lineup aiming for equal time in that game.
- **⚙ Setup tab** — the Game Format card (halves × half length, sub
  interval, squad size, players on court), player names, availability
  (Away/Injured are removed from rotations; 😴 Tired plays the lighter
  ones), and the current game's rotations (tap to swap, hold & drag to
  reorder, ✨ Auto-balance before tip-off). Once a game is underway the
  button becomes **Re-balance rest**: played rotations and recorded
  minutes stay as they are, and only the rotations still to come are
  rebuilt, starting from who's on court now.
- **⏱ Time tab** — court time per player, toggled between **this game**
  and the **whole day**, each against its fair-share target, plus a
  rotation log for every game.
- **📝 Player notes & 📤 export** — tap 📝 next to a player on the Time tab
  to jot game-day notes on her. "Export day summary" opens the phone's
  share sheet with a plain-text summary (minutes per game, day totals,
  player notes) ready to save into Apple Notes, Messages, or email.

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
