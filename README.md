# pocketmittens

Chrome extension that reads the board on lichess.org or chess.com, runs a neural network over
the position, and draws the recommended move as an arrow with a SAN and evaluation label.
Clicks and drags pass through the overlay, and there is no auto-move feature.

The network is a self-play-trained policy/value net exported to ONNX; it runs locally in the
browser through onnxruntime-web, so nothing leaves your machine.

**Fair play:** engine and neural-net assistance in rated online games violates both sites'
rules. Use this on analysis boards, puzzles, unrated and friendly games, and bot games only.

## Setup

```
npm install
npm run build        # writes dist/
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select
the `dist/` folder — not the project root. After any rebuild, click reload on the extension card
and refresh open board tabs.

### Supplying a model

Weights are not distributed with this repo, so `models/` starts empty and the build will stop
with a message until you put exactly one `.onnx` in it. Two ways to get one:

- Train a network with the accompanying training harness and export it:
  `python -m harness export --checkpoint <checkpoint>.pt --verify --device cpu`
- Use any ONNX model matching the frozen contract: input `board` of shape `[N, 18, 8, 8]`,
  outputs `policy` `[N, 4672]` and `value` `[N, 1]`, with the plane and move-index layout in
  `src/common/encoding.js`.

A `.pt` is a PyTorch checkpoint and cannot run in a browser — export it to ONNX first. To swap
models later, replace the file in `models/` and run `npm run build` again.

## How it works

The content script scrapes the page for the move list and the piece placement, then derives a
FEN. The move list is replayed to get an exact position, and reconciled backwards against the
scraped pieces so that scrolling back through a game resolves to the ply actually on screen. If
the moves cannot be replayed — a board set up from a FEN, or a chess.com sideline — it falls
back to reading the pieces alone. That fallback cannot always tell whose turn it is, and when it
cannot it shows no arrow rather than a confidently backwards one.

The position goes to an offscreen document, which runs a PUCT Monte-Carlo tree search over the
network: the policy head supplies priors, the value head scores leaves, and the most-visited
move at the root is the one drawn. A few details mirror the search the network trained against,
because a net plays best under the search it was shaped by — unvisited moves inherit the
parent's value rather than scoring zero, a position repeating one from the game counts as a
draw, and a checkmate at the root is played immediately instead of waiting on visit counts.

The popup's **Search strength** sets the simulation count:

| Sims | Latency |
| ---- | ------- |
| 0    | instant — raw policy, no search |
| 32   | ~1 s |
| 64   | ~2 s |
| 128  | ~3–4 s (default) |
| 256  | ~7 s |

Approximate: one network evaluation costs roughly 20 ms on a mid-range laptop CPU and the search
needs one per simulation, so these scale with your machine. More simulations find tactics the raw
policy misses. The default only applies to a fresh install; once set, your choice persists in
extension storage.

A search superseded by a newer position is cancelled, so only the current position's arrow
renders. Hints are computed for the visible tab only.

## Development

`npm test` runs the test suite. `npm run watch` rebuilds on change.

If something goes wrong, inference errors surface in the offscreen document's console:
`chrome://extensions` → pocketmittens → *Details* → *Inspect views* → `offscreen/offscreen.html`.
If no arrow appears, check the popup's FEN line — "No position detected" means the scraper could
not derive a position, which usually means the site's DOM changed.

## License

MIT — see [LICENSE](LICENSE).
