# scan-audio-waveform — Waveform Barcode v2

This repository is a small demo app (Vite + React) that implements a visual "waveform barcode" format. The app can:

- Generate a compact visual barcode from a numeric media ID (or encode a URL into a numeric ID and store it locally),
- Render the barcode as a PNG you can download or display,
- Scan the barcode from a camera capture or an uploaded image and decode the original numeric ID,
- (Demo) Map decoded IDs to URLs stored in the browser's `localStorage` and redirect to them.

The core ideas are: use a CRC to detect errors, Gray-code the small 3-bit groups to reduce bit flips from small measurement errors, and permute groups so adjacent bits are not physically adjacent on the barcode.

This README is a complete project-level guide: quick start, how the algorithm works, scanner tips, file layout, development notes and troubleshooting.

---

## Quick start

Requirements:
- Node.js (LTS recommended)

Install and run the dev server:

```bash
cd /Users/zerotb/Documents/scan-audio-waveform
npm install
npm run dev
```

Open the URL reported by Vite (typically `http://localhost:5173`).

## What you can do in the app

- **Generate**: Enter a numeric ID or paste a URL and click `Encode`. The app will (for demo) generate a numeric ID for the URL, store it in `localStorage` and draw the barcode.
- **Download**: Save the generated barcode as a PNG for printing or sharing.
- **Scan**: Choose `Camera` to capture and decode from your device camera, or `Upload Image` to decode from a file.
- **Redirect**: If a decoded ID matches a mapping in `localStorage`, the app will redirect to the stored URL (demo behavior).

---

## Files & structure

- `index.html`, `vite.config.js`, project boilerplate
- `src/`
  - `main.jsx` — app entry
  - `App.jsx` — root component, renders `WaveformBarcodeV2`
  - `WaveformBarcodeV2.jsx` — main component with encoding, rendering, scanning and UI
  - `assets/` — images used by the app
- `README.md` — this file

The main implementation is in `src/WaveformBarcodeV2.jsx`.

---

## The algorithm (concise)

Encoding summary:

1. Input: numeric media ID (0..40-bit max). For demo we accept up to 10 decimal digits.
2. Compute a CRC-8 (polynomial 0x07) over the 5-byte big-endian representation of the 40-bit ID.
3. Concatenate the 40-bit ID and the 8-bit CRC to get 48 bits.
4. Split the 48 bits into 16 groups of 3 bits (MSB-first), each value 0..7.
5. Apply a 3-bit Gray code mapping to each 3-bit group so small level errors change only one bit.
6. Permute the 16 Gray values using the mapping `(i * 7) % 16` to spread adjacent groups physically apart.
7. Layout the final barcode as 23 bars: `[0] + first 10 permuted + [7] + next 10 permuted + [0]` (fixed reference bars help calibration).

Decoding summary:

1. Detect bars and measure heights (levels 0..7) from an image or video frame.
2. Verify reference bars (start, middle, end) for sanity.
3. Extract the 16 permuted data values (skip the 3 reference bars) and reverse the permutation.
4. Gray-decode each value back to 3-bit groups and reassemble into a 48-bit integer.
5. Separate CRC and data, recompute CRC over the recovered data and compare — if they match, decoding is successful.

Notes: CRC helps detect read errors. Gray code and permutation reduce catastrophic failures from small measurement offsets or single-bar drops.

---

## Scanning approach (how the scanner detects bars)

- The scanner samples a few horizontal scanlines near the image center (configurable lines at 40–60% of image height).
- For each scanline it finds contiguous dark pixel runs (candidate bars), filters small noise runs, and measures each candidate's vertical height by expanding up/down from the bar center.
- The tallest detected bar is assumed to represent level 7, and `unitH = maxHeight / 8` is used to quantize each bar's measured height to a level 0..7.
- After quantization, bars are trimmed/padded to 23 items and passed to the decoder.

Limitations and failure modes:

- The scanner assumes vertically aligned bars and does not perform rotation correction.
- Very blurred images, extreme perspective, or low contrast will reduce detection reliability.

---

## Local mapping (demo URL storage)

For demonstration, the app stores mappings in `localStorage`:
`waveform:url:<id> = <url>`

- When you click `Encode` (with a URL present) the UI generates a random 10-digit numeric ID, saves the mapping in `localStorage` and draws the barcode for that ID.
- When scanning, the app looks up `localStorage` and redirects if the mapping exists.

Production note: For a real service you should replace `localStorage` with a server-side resolver (API + persistent database) so any client can resolve the ID to a URL.

---

## Developer notes & common troubleshooting

Camera access errors
- If the browser reports camera permission errors, check:
  - Browser permissions (site settings → Camera → Allow).
  - macOS Privacy (System Settings → Privacy & Security → Camera) and ensure your browser is allowed.
  - Run the app from `localhost` (Vite dev server). `getUserMedia` requires secure context (HTTPS) for remote hosts.
- If `TypeError: Cannot set properties of null (setting 'srcObject')` appears, the code attaches the stream after the `<video>` mounts. Reload and try again; check the console for details.

Scanning reliability tips
- Display or print barcodes at decent size (each bar should be several pixels wide when captured by the camera).
- Use plain, high-contrast backgrounds and avoid reflections.

Linting and hooks
- The component uses `useCallback` and `useEffect` to keep stream handling predictable. If you modify the hooks, run the dev server and check console for React hook warnings.

---

## Development ideas / next steps

- Add server-backed mapping (Node/Express + small DB) so encoded barcodes are globally resolvable.
- Improve scanner robustness with: rotation correction, adaptive thresholding, morphological filters, or a small ML model.
- Add error correction (Reed-Solomon or BCH) to correct a small number of bar errors rather than only detect them with CRC.
- Generate a small set of test PNGs at multiple sizes to tune scanning thresholds.

---

If you want, I can now:

- Scaffold a tiny server (Express) and update the client to use it for mapping/lookup.
- Generate example barcode PNGs for testing at different scales and include them under `public/`.
- Add a short developer checklist and unit tests for the encode/decode functions.

Choose one and I'll implement it next.

File pointers
- Implementation: `src/WaveformBarcodeV2.jsx`
- Root app: `src/App.jsx`
- This file: `README.md`

---

## Overview

The barcode is a visual representation made of 23 vertical bars. It encodes up to 40 bits of data (a numeric media ID) plus an 8-bit CRC (CRC-8, poly 0x07), for a total of 48 bits. To make the barcode tolerant to single-bar read errors and small measurement errors, we:

- Split the 48 bits into 16 groups of 3 bits (0-7). Each 3-bit value is converted to a Gray-coded level (0-7).
- Permute the 16 Gray-coded values before layout to avoid having adjacent bits stored in adjacent bars.
- Surround the data area with three reference bars with fixed heights: low (0) at the start, high (7) at the middle, and low (0) at the end. These help calibrate the scan and detect orientation.

Final structure (23 bars):
- [ref=0] + 10 data bars + [ref=7 center] + 10 data bars + [ref=0 end] = 23 bars

Bar heights are discrete levels (0..7). For rendering we convert level -> visual height (unit height × (level + 1)).

## Data format

- Input: numeric ID (0 through 9,999,999,999 — fits in 40 bits) — in the code this is treated as a 40-bit integer.
- CRC: CRC-8 (polynomial x^8 + x^2 + x + 1, i.e. polynomial 0x07) computed over the 5 bytes (40 bits) big-endian.
- Combined bits: 40 bits data followed by 8-bit CRC (total 48 bits).
- Grouping: treat the 48-bit value as 16 groups of 3 bits each (MSB-first), values range 0..7.
- Gray encoding: map each 3-bit group via GRAY_ENCODE = [0,1,3,2,6,7,5,4]. This reduces the number of bit flips between adjacent levels.
- Permutation: permute the 16 Gray values with index mapping (i*7) % 16 to spread consecutive groups across the barcode.

## Encoding algorithm (step-by-step)

1. Validate input numeric ID (0 <= id <= 40-bit max). Convert to a 5-byte big-endian array.
2. Compute `crc = CRC8(bytes)` (polynomial 0x07, initial 0).
3. Build `combined = (id << 8) | crc` — a 48-bit integer.
4. For i from 15 down to 0: extract 3-bit value `v = (combined >> (i*3)) & 0x7`.
5. Map `v` through Gray encoder: `g = GRAY_ENCODE[v]` and accumulate into a 16-length array.
6. Apply permutation: `permuted[i] = dataHeights[(i * 7) % 16]`.
7. Build final heights array with reference bars: `[0] + permuted[0..9] + [7] + permuted[10..19] + [0]`. (Implementation note: permuted has length 16; layout places the first 10 and last 6 into the two halves and pads to 10 as needed.)

The app draws each level with a visual height of `(level + 1) * UNIT_HEIGHT` and rounded-caps for visual clarity.

## Decoding algorithm (step-by-step)

1. Pre-check: barcode must contain 23 bars.
2. Verify reference bars: start/end bars are low (near 0) and center bar is high (near 7). If these checks fail, abort.
3. Extract the 20 data positions (skip indices 0, 11, 22) and assemble 16 data items (10 from first side and 10 from second; the implementation extracts 10 + 10 and uses first 16 values as permuted groups).
4. Reverse permutation: `unpermuted[(i * 7) % 16] = dataHeights[i]` to reconstruct original Gray sequence.
5. Gray-decode each value using GRAY_DECODE (inverse array) to get the original 3-bit values.
6. Recombine the 16 triplets into a 48-bit integer: bits shifted in MSB-first order.
7. Extract `checksum = combined & 0xFF` and `data = combined >> 8`.
8. Recompute CRC over `data` (5 bytes) and compare to `checksum`. If mismatch → invalid (or report CRC error). If match → return decoded numeric ID.

## Scanning heuristics and robustness

The visual scanner uses simple image processing, optimized for live captures and quick decoding:

- Grayscale brightness sampling: use pixel average (R+G+B)/3.
- Multiple horizontal scan lines: scan several rows around the vertical center (e.g., 40%-60% of image height) and pick the result with most detected bars.
- Bar detection along a scanline: find contiguous black segments, ignore very narrow segments (< threshold), compute each bar's center X and vertical height by expanding up/down to find top/bottom of black area.
- Unit calibration: the code assumes the tallest detected bar corresponds to the reference max-height (level 7) and derives `unitH = maxBarHeight / 8`. Levels are computed as `round(barHeight / unitH) - 1` and clamped to 0..7.
- Padding/trimming: if the detected bars are fewer than 23, the algorithm may pad with zeros or reject (current implementation expects at least ~15 bars for a reasonable attempt).

Limitations:
- The scanner assumes a mostly upright barcode with bars vertically aligned. It does not automatically rotate the image to correct skew.
- Barcode must have enough contrast and reasonable resolution — very small prints or heavy blur will fail.

Tips for reliable scanning
- Print or display the barcode large enough so each bar is several pixels wide in the camera image.
- Use a plain background with high contrast (black bars on white background recommended).
- Center the barcode in the camera frame and try to align the bars vertically.

## Local mapping & usage (YouTube flow)

This project includes a local mapping convenience for demo purposes:

- When the user encodes a URL via the UI, the app generates a random 10-digit numeric ID and stores the mapping in the browser's `localStorage` under key `waveform:url:<id>`.
- The barcode that gets generated encodes that numeric ID.
- When a scanner decodes an ID, it looks up `localStorage` for the matching key; if present, it redirects the browser to the stored URL.

Important: this mapping is local to the browser. For a production service you should store mappings on a server (HTTP API) so any client can resolve the ID to a URL.

## Usage (developer)

Start the dev server (Vite):

```bash
cd /Users/zerotb/Documents/scan-audio-waveform
npm install
npm run dev
```

Open the app in your browser (Vite will show a URL like `http://localhost:5173`).

Generate flow:
- Enter a URL in the "YouTube URL" field and click `Encode`. The app will create a numeric ID, store the mapping locally and draw the barcode.
- Or enter a numeric ID manually and click `Generate`.
- Download the PNG for printing or sharing.

Scan flow:
- In the `Scan` tab choose `Camera` (or `Upload Image`).
- For camera mode, click `Start Camera` then `Capture & Decode` to attempt decoding the barcode.
- If a mapping exists in localStorage for the decoded ID, the scanner will redirect the page to the mapped URL.

## Developer notes & extensions

- The scanner is intentionally lightweight and implemented in the browser (no worker threads). For better performance and robustness:
  - Add rotation detection and deskewing (Hough transform or orientation heuristics).
  - Use adaptive thresholding instead of a fixed brightness cutoff.
  - Implement a small error-correction code (e.g., BCH or reed-solomon) if you need more reliability than CRC provides.

- For production mapping:
  - Replace the `localStorage` mapping with a server-side resolver. The barcode would encode a numeric key; the server maps it to the current resource URL.

- Testing: sample PNGs should be generated at a few scales and scanned to validate thresholds and unit calibration.

## Example (conceptual)

- ID: `1234567890` → bytes: [0x00, 0x00, 0x00, 0x49, 0x96, 0x02] (conceptual) → CRC → combined 48-bit → groups → Gray map → permute → final heights array (23 items) → drawn.

---

If you'd like, I can also:
- Add a small server example (Node/Express) to store mappings and fetch them during scan.
- Generate a set of example PNG barcodes for testing at several sizes and camera distances.
- Improve the scanner with adaptive thresholding and rotation tolerance.

File: `src/WaveformBarcodeV2.jsx` contains the implementation; read it for code-level details.
# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is currently not compatible with SWC. See [this issue](https://github.com/vitejs/vite-plugin-react/issues/428) for tracking the progress.

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
