# Swarm Rebuild

A Chrome extension that wipes any page to a blank canvas and rebuilds it in front of you with a swarm of colorful, multiplayer-style cursors — like watching a design team assemble the page live in a design tool.

Built for local use. Not published to the Chrome Web Store.

## What it does

Click the toolbar icon (or press `Alt+Shift+S`) on any page. The page fades to a blank canvas and a swarm of named agents rebuilds it, element by element:

- **Boxes** are dragged out from a crosshair with a live size badge (`327 × 136`) and corner handles.
- **Headlines and paragraphs** are typed character by character with a blinking caret, line by line.
- **Borders** are traced with a pen tool and then filled in.
- **Ruler guides** snap to each element as it is placed.
- **Cards, nav links and list rows** are dragged in with an `⌥` ghost, then retyped.
- **Images** are drawn as a box and fade in.
- **Shadow DOM** components are rebuilt too (open shadow roots).

The swarm reacts to you:

- **Scroll** and the swarm chases the viewport, calling in more agents (up to 14).
- **Tour** auto-scrolls the page from top to bottom while the swarm keeps building.
- **1× / 2× / 3×** speed control.
- When everything visible is built, the cursors **flock to your mouse**.
- **Go live** fades the real page back in.
- **Replay** wipes the canvas and builds it again.
- **Esc**, the toolbar icon, or the `×` button exits at any time.

## Install (load unpacked)

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `extension/` folder.
5. Pin **Swarm Rebuild** from the puzzle-piece menu if you want it on the toolbar.

The keyboard shortcut `Alt+Shift+S` is assigned automatically. If it conflicts with another extension, change it at `chrome://extensions/shortcuts`.

Works in Chrome, Edge, Brave, Arc, and other Chromium browsers.

## Permissions

Only `activeTab` and `scripting`. The extension injects its script into the current tab only when you click the icon or press the shortcut. Nothing is collected, stored, or sent anywhere — there is no network code, no storage, no analytics, and no background behaviour beyond the click handler.

## How it works

The live page is not modified. Instead, the extension clones the current document (including open shadow roots and canvas pixels) into a sandboxed preview, hides the clone's content, and reveals it piece by piece while the cursors draw over it. When you exit, the overlay is removed and the original page is exactly as it was.

Because the preview is a snapshot:

- Scripts, videos, and iframes in the page are not carried over (videos show as a still frame, iframes as an empty frame).
- Content that only exists after user interaction, or inside closed shadow roots, is not rebuilt.
- Very long pages build the visible area first and continue as you scroll.

## Credits

Inspired by the "Swarm" concept by Joel Califa and the "Swarm Rebuild" extension by Dhvanil Patel. This is an independent reimplementation from scratch.

## License

MIT
