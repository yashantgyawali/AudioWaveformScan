import React, { useState, useRef, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import songLinks from "./songLinks.json";
import SongLinkCard from "./SongLinkCard";

const BAR_WIDTH = 24;
const SPACING = 4;
const UNIT_HEIGHT = 22;
const PADDING = 30;
const CANVAS_HEIGHT = 280;
const NUM_BARS = 23;

const GRAY_ENCODE = [0, 1, 3, 2, 6, 7, 5, 4];
const GRAY_DECODE = [0, 1, 3, 2, 7, 6, 4, 5];
const BAR_THEME = {
  background: "#504B81",
  primaryBar: "#F6ECFF",
  referenceBar: "#C7B1FF",
  frame: "#3F3A66",
};

const crc8 = (data) => {
  let crc = 0;
  for (let byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x80) crc = ((crc << 1) ^ 0x07) & 0xff;
      else crc = (crc << 1) & 0xff;
    }
  }
  return crc;
};

const numToBytes = (num, len) => {
  const bytes = [];
  for (let i = len - 1; i >= 0; i--) bytes.push((num >> (i * 8)) & 0xff);
  return bytes;
};

const MAX_40BIT = 0xffffffffff;

const encodeToHeights = (mediaRef) => {
  const num = Number.parseInt(mediaRef, 10);
  if (Number.isNaN(num) || num < 0 || num > MAX_40BIT) return null;
  const bytes = numToBytes(num, 5);
  const checksum = crc8(bytes);
  const combined = (BigInt(num) << 8n) | BigInt(checksum);
  const dataHeights = [];
  for (let i = 15; i >= 0; i--) {
    const bits = Number((combined >> BigInt(i * 3)) & 7n);
    dataHeights.push(GRAY_ENCODE[bits]);
  }
  const permuted = [];
  for (let i = 0; i < 16; i++) permuted.push(dataHeights[(i * 7) % 16]);
  const heights = [0];
  for (let i = 0; i < 10; i++) heights.push(permuted[i] ?? 0);
  heights.push(7);
  for (let i = 10; i < 20; i++) heights.push(permuted[i] ?? 0);
  heights.push(0);
  return heights;
};

const decodeFromHeights = (heights) => {
  if (heights.length !== NUM_BARS) return { error: "Invalid bar count" };
  if (heights[0] > 1 || heights[NUM_BARS - 1] > 1)
    return { error: "Invalid start/end markers" };
  if (heights[11] < 6) return { error: "Invalid center reference bar" };
  const dataHeights = [];
  for (let i = 1; i <= 10; i++) dataHeights.push(heights[i]);
  for (let i = 12; i <= 21; i++) dataHeights.push(heights[i]);
  const unpermuted = new Array(16);
  for (let i = 0; i < 16; i++) unpermuted[(i * 7) % 16] = dataHeights[i];
  let combined = 0n;
  for (let i = 0; i < 16; i++) {
    const grayVal = Math.min(7, Math.max(0, Math.round(unpermuted[i])));
    const bits = GRAY_DECODE[grayVal];
    combined = (combined << 3n) | BigInt(bits);
  }
  const checksum = Number(combined & 0xffn);
  const data = Number(combined >> 8n);
  const bytes = numToBytes(data, 5);
  const calculatedCrc = crc8(bytes);
  if (calculatedCrc !== checksum) return { error: `CRC mismatch`, data };
  return { data, valid: true };
};

export const urlMap = new Map();
export const songMetaMap = new Map();

songLinks.forEach(({ id, url, thumbnail }) => {
  const numericId = Number(id);
  if (Number.isNaN(numericId) || !url) return;
  urlMap.set(numericId, url);
  songMetaMap.set(numericId, {
    url,
    thumbnail: thumbnail || null,
  });
});

export const decodeCanvas = (canvas, { smallMode = false } = {}) => {
  const ctx = canvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const getBrightness = (x, y) => {
    if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) return 255;
    const i = (Math.floor(y) * canvas.width + Math.floor(x)) * 4;
    return (data[i] + data[i + 1] + data[i + 2]) / 3;
  };

  const sampleStepX = Math.max(1, Math.floor(canvas.width / 80));
  const sampleStepY = Math.max(1, Math.floor(canvas.height / 80));
  const samples = [];
  for (let y = 0; y < canvas.height; y += sampleStepY) {
    for (let x = 0; x < canvas.width; x += sampleStepX) {
      samples.push(getBrightness(x, y));
    }
  }

  if (samples.length === 0) return { error: "Empty image" };
  const sortedSamples = [...samples].sort((a, b) => a - b);
  const backgroundBrightness =
    sortedSamples[Math.floor(sortedSamples.length / 2)];
  const minBrightness = sortedSamples[0];
  const maxBrightness = sortedSamples[sortedSamples.length - 1];
  const lightDiff = maxBrightness - backgroundBrightness;
  const darkDiff = backgroundBrightness - minBrightness;
  const detectLightBars = lightDiff > darkDiff;
  const contrast = detectLightBars ? lightDiff : darkDiff;
  const minContrast = smallMode ? 6 : 10;
  if (contrast < minContrast)
    return { error: "Barcode contrast too low to detect" };
  const thresholdBase = detectLightBars
    ? backgroundBrightness + contrast * 0.45
    : backgroundBrightness - contrast * 0.45;
  const threshold = Math.max(0, Math.min(255, thresholdBase));
  const isBarPixel = (x, y) => {
    const brightness = getBrightness(x, y);
    return detectLightBars ? brightness >= threshold : brightness <= threshold;
  };

  const scanLines = (smallMode
    ? [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65]
    : [0.4, 0.45, 0.5, 0.55, 0.6]
  ).map((r) => Math.floor(canvas.height * r));
  let bestBars = [];
  for (const centerY of scanLines) {
    const bars = [];
    let inBar = false,
      barStart = 0;
    for (let x = 0; x < canvas.width; x++) {
      const inWave = isBarPixel(x, centerY);
      if (inWave && !inBar) {
        inBar = true;
        barStart = x;
      } else if (!inWave && inBar) {
        inBar = false;
        const barWidth = x - barStart;
        // For smallMode tolerate narrower bars, but still reject single-pixel noise
        const minBarWidth = smallMode
          ? Math.max(3, Math.floor(canvas.width / 400))
          : 8;
        if (barWidth >= minBarWidth) {
          const centerX = barStart + barWidth / 2;
          let topY = centerY,
            bottomY = centerY;
          while (topY > 0 && isBarPixel(centerX, topY - 1)) topY--;
          while (
            bottomY < canvas.height - 1 &&
            isBarPixel(centerX, bottomY + 1)
          )
            bottomY++;
          bars.push({ centerX, height: bottomY - topY + 1 });
        }
      }
    }
    if (bars.length > bestBars.length) bestBars = bars;
  }
  if (bestBars.length < 15)
    return { error: `Found ${bestBars.length} bars, need 15+` };
  const maxHeight = Math.max(...bestBars.map((b) => b.height));
  const unitH = maxHeight / 8;
  const detectedHeights = bestBars.map((bar) => {
    const level = Math.round(bar.height / unitH) - 1;
    return Math.max(0, Math.min(7, level));
  });
  while (detectedHeights.length < NUM_BARS) detectedHeights.push(0);
  return decodeFromHeights(detectedHeights.slice(0, NUM_BARS));
};

function WaveformBarcodeV2() {
  // lightweight routing fallback: derive mode from window.location and allow navigation
  const modeFromPath = (path) => {
    if (path.startsWith("/generate")) return "generate";
    if (path.startsWith("/info")) return "info";
    return "scan";
  };
  const [mode, setMode] = useState(modeFromPath(window.location.pathname));
  const navigate = (path) => {
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
      setMode(modeFromPath(path));
    }
  };

  const [mediaRef, setMediaRef] = useState("1234567890");
  const [heights, setHeights] = useState([]);
  const [decoded, setDecoded] = useState(null);
  const [error, setError] = useState("");
  const canvasRef = useRef(null);
  const videoRef = useRef(null);
  const scanCanvasRef = useRef(null);
  const [scanning, setScanning] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [mappedId, setMappedId] = useState("");
  const [mappedUrl, setMappedUrl] = useState("");
  const [mappedSong, setMappedSong] = useState(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [smallBarcodeMode, setSmallBarcodeMode] = useState(false);
  const streamRef = useRef(null);
  const focusTrackRef = useRef(null);
  const trackCapabilitiesRef = useRef(null);
  const autoStartDoneRef = useRef(false);
  const [isMobileView, setIsMobileView] = useState(
   typeof window !== "undefined" ? window.innerWidth < 640 : false
 );
 
 useEffect(() => {
   const onResize = () => setIsMobileView(window.innerWidth < 640);
   window.addEventListener("resize", onResize);
   return () => window.removeEventListener("resize", onResize);
 }, []);

  const drawRoundedRect = (ctx, x, y, w, h, r) => {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
    ctx.fill();
  };

  const drawHeights = useCallback((result) => {
    if (!result || !canvasRef.current) return;
    setHeights(result);
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const totalWidth =
      (BAR_WIDTH + SPACING) * result.length - SPACING + PADDING * 2;
    canvas.width = totalWidth;
    canvas.height = CANVAS_HEIGHT;
    ctx.fillStyle = BAR_THEME.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const centerY = canvas.height / 2;
    let x = PADDING;
    result.forEach((height, i) => {
      const barHeight = (height + 1) * UNIT_HEIGHT;
      const y = centerY - barHeight / 2;
      const isRef = i === 0 || i === 11 || i === result.length - 1;
      ctx.fillStyle = isRef ? BAR_THEME.referenceBar : BAR_THEME.primaryBar;
      drawRoundedRect(ctx, x, y, BAR_WIDTH, barHeight, BAR_WIDTH / 2);
      x += BAR_WIDTH + SPACING;
    });
  }, []);

  const generateBarcode = useCallback(() => {
    const result = encodeToHeights(mediaRef);
    if (!result) {
      setError(`Enter a number between 0 and ${MAX_40BIT}`);
      return;
    }
    setError("");
    drawHeights(result);
  }, [mediaRef, drawHeights]);

  // stopScanning must be declared before effects that reference it
  const stopScanning = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setScanning(false);
    setCameraReady(false);
  }, []);

  // keep UI mode in sync with browser navigation (back/forward)
  useEffect(() => {
    const onPop = () => setMode(modeFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (mode === "generate") generateBarcode();
  }, [mode, generateBarcode]);

  useEffect(() => {
    if (mode !== "scan") stopScanning();
  }, [mode, stopScanning]);

  const startScanning = useCallback(async () => {
    setError("");
    setDecoded(null);
    setMappedUrl("");
    setMappedSong(null);
    setCameraReady(false);

    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      streamRef.current = stream;
      setScanning(true);

      // IMPORTANT: Set srcObject AFTER state update so video element exists
      setTimeout(async () => {
        const video = videoRef.current;
        if (video && stream) {
          video.srcObject = stream;

          // try to enable continuous/autofocus if supported
          try {
            const [track] = stream.getVideoTracks();
            focusTrackRef.current = track;
            const caps = track.getCapabilities ? track.getCapabilities() : {};
            trackCapabilitiesRef.current = caps;
            // prefer continuous or auto focus if available
            if (caps.focusMode && Array.isArray(caps.focusMode)) {
              const want = caps.focusMode.includes("continuous")
                ? "continuous"
                : caps.focusMode.includes("auto")
                ? "auto"
                : null;
              if (want) {
                await track.applyConstraints({ advanced: [{ focusMode: want }] });
              }
            }
          } catch (e) {
            // ignore if device/browser doesn't support focus controls
            console.debug("Focus setup not supported:", e);
          }

        }
      }, 50);
    } catch (err) {
      console.error("Camera error:", err);
      setError(`Camera error: ${err.message || "Unknown"}. Check permissions.`);
      setScanning(false);
    }
  }, []);
  
  // Tap-to-focus: best-effort using pointsOfInterest / focusMode / focusDistance
  const handleVideoFocusTap = useCallback(
    async (e) => {
      try {
        const video = videoRef.current;
        const track = focusTrackRef.current;
        const caps = trackCapabilitiesRef.current || {};
        if (!video || !track) return;
        const rect = video.getBoundingClientRect();
        const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

        // pointsOfInterest (Safari-like)
        if (caps.pointsOfInterest) {
          await track.applyConstraints({ advanced: [{ pointsOfInterest: [{ x: nx, y: ny }] }] });
          return;
        }

        // single-shot focus modes
        if (caps.focusMode && caps.focusMode.includes("single-shot")) {
          await track.applyConstraints({ advanced: [{ focusMode: "single-shot" }] });
          return;
        }

        // fallback: if focusDistance available, set to nearest supported value
        if (typeof caps.focusDistance === "object" && caps.focusDistance.min != null) {
          await track.applyConstraints({ advanced: [{ focusDistance: caps.focusDistance.min }] });
          return;
        }
      } catch (err) {
        console.debug("Tap-to-focus not supported:", err);
      }
    },
    []
  );

  // Auto-start camera when on the scan route
  useEffect(() => {
    if (mode === "scan" && !scanning && !autoStartDoneRef.current) {
      startScanning();
      autoStartDoneRef.current = true; // don't auto-restart after stop/success
    }
  }, [mode, scanning, startScanning]);

  const handleVideoCanPlay = () => {
    const video = videoRef.current;
    if (video) {
      video
        .play()
        .then(() => {
          setCameraReady(true);
        })
        .catch((e) => {
          console.warn("Play failed:", e);
          setError("Video play failed. Try clicking the video area.");
        });
    }
  };

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const handleEncodeUrl = () => {
    if (!urlInput.trim()) {
      setError("Enter a URL to encode");
      return;
    }
    const url = urlInput.trim();
    const id = Math.floor(Math.random() * 1e10);
    urlMap.set(id, url);
    songMetaMap.set(id, { url, thumbnail: null });
    setMappedId(String(id));
    setMediaRef(String(id));
    const h = encodeToHeights(String(id));
    if (h) {
      drawHeights(h);
      setError("");
      setMappedSong(null);
    }
  };

  const captureAndDecode = useCallback(() => {
    const video = videoRef.current;
    const canvas = scanCanvasRef.current;
    if (!video || !canvas) {
      setError("Video not ready");
      return;
    }
    if (!video.videoWidth || !video.videoHeight) {
      setError("Camera not ready - wait a moment");
      return;
    }

    const ctx = canvas.getContext("2d");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    const result = decodeCanvas(canvas, { smallMode: smallBarcodeMode });
    if (result.error) {
      setError(result.error);
      setDecoded(null);
      setMappedSong(null);
      setMappedUrl("");
      return;
    }
    setDecoded(result);
    setError("");
    if (result.valid) {
      // Ensure we don't auto-restart after a successful decode
      autoStartDoneRef.current = true;
      const url = urlMap.get(result.data);
      const songMeta = songMetaMap.get(result.data);
      if (songMeta) {
        setMappedSong(songMeta);
        setMappedUrl(songMeta.url);
      } else if (url) {
        setMappedSong(null);
        setMappedUrl(url);
      } else {
        setMappedSong(null);
        setMappedUrl("");
      }
      stopScanning();
    }
  }, [stopScanning]);

  useEffect(() => {
    if (!scanning || !cameraReady) return;
    const intervalId = setInterval(() => {
      captureAndDecode();
    }, 1200);
    return () => clearInterval(intervalId);
  }, [scanning, cameraReady, captureAndDecode]);

  const downloadBarcode = () => {
    const link = document.createElement("a");
    link.download = `waveform-${mediaRef}.png`;
    link.href = canvasRef.current.toDataURL("image/png");
    link.click();
  };

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <h1 className="text-xl font-bold mb-1 text-center">
        Waveform Barcode v2
      </h1>
      <p className="text-sm text-gray-500 text-center mb-4">
        With CRC, Gray Code & Permutation
      </p>

      {/* navigation removed — direct URLs /generate and /info still work */}
      <div className="h-2" />

      {mode === "generate" && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              YouTube URL:
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                className="flex-1 p-3 border rounded-lg"
                placeholder="https://youtube.com/watch?v=..."
              />
              <button
                onClick={handleEncodeUrl}
                className="px-4 py-3 bg-indigo-600 text-white rounded-lg"
              >
                Encode
              </button>
            </div>
            {mappedId && (
              <p className="text-xs text-gray-600 mt-1">
                Saved ID: <span className="font-mono">{mappedId}</span>
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              Or enter ID directly:
            </label>
            <input
              type="text"
              value={mediaRef}
              onChange={(e) =>
                setMediaRef(e.target.value.replace(/[^0-9]/g, "").slice(0, 12))
              }
              className="w-full p-3 border rounded-lg font-mono text-lg"
            />
            <button
              onClick={generateBarcode}
              className="mt-2 px-4 py-2 bg-gray-800 text-white rounded"
            >
              Generate
            </button>
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <div
            className="p-4 rounded-lg flex justify-center"
            style={{ backgroundColor: BAR_THEME.frame }}
          >
            <canvas ref={canvasRef} className="max-w-full" />
          </div>
          <button
            onClick={downloadBarcode}
            className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium"
          >
            Download PNG
          </button>
          <div className="text-xs text-gray-600 bg-gray-50 p-3 rounded font-mono">
            <p>
              <strong>Heights:</strong> [{heights.join(", ")}]
            </p>
          </div>
        </div>
      )}

      {mode === "scan" && (
        // removed the large min-height so the scanner area stays compact and avoids page scroll
        <div className="space-y-4 flex flex-col min-h-0">
           <div className="flex-1 flex flex-col gap-3">
            <div
              className="relative flex-1 rounded-2xl overflow-hidden bg-transparent"
              style={
                isMobileView
                  ? {
                      width: "100%",
                      aspectRatio: "1 / 1", // square on phones
                      maxHeight: "320px",
                    }
                  : { height: "140px" } // reduced desktop preview height
              }
            >
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                onCanPlay={handleVideoCanPlay}
                onClick={handleVideoFocusTap}
                style={{
                  width: "100%",
                  height: "100%",
                  display: "block",
                  objectFit: "cover", // crop to keep preview compact
                  cursor: "crosshair",
                }}
              />

              {/* START: minimal starting indicator (transparent background) */}
              {!cameraReady && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="text-white text-center space-y-2">
                    <div className="animate-spin w-8 h-8 border-4 border-white border-t-transparent rounded-full mx-auto"></div>
                    <p className="text-xs tracking-wide uppercase">Starting camera…</p>
                  </div>
                </div>
              )}
              {/* END: minimal starting indicator */}

              {/* Removed: scanner tips, purple guide frame and bottom status to leave only the preview */}
            </div>

            <button onClick={stopScanning} className="w-full py-3 bg-red-600 text-white rounded-lg">
              Stop Camera
            </button>
          </div>

          <canvas ref={scanCanvasRef} style={{ display: "none" }} />

          {error && <p className="text-red-500 text-sm">{error}</p>}

          {/* Success banner shown when a valid barcode decoded */}
          {decoded && decoded.valid && (mappedSong || mappedUrl) && (
            <div className="p-3 rounded-lg bg-green-50 border border-green-200 flex items-center gap-3">
              <div className="flex-shrink-0 w-12 h-12 bg-gray-100 rounded overflow-hidden">
                {/* show thumbnail if available */}
                {mappedSong && mappedSong.thumbnail ? (
                  <img src={mappedSong.thumbnail} alt="thumbnail" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-500">♪</div>
                )}
              </div>
              <div className="flex-1">
                <div className="font-semibold text-sm">Detected!</div>
                <div className="text-xs text-gray-600">
                  {mappedSong ? mappedSong.url : mappedUrl}
                </div>
              </div>
              <a
                href={mappedSong ? mappedSong.url : mappedUrl}
                target="_blank"
                rel="noreferrer"
                className="px-3 py-1 bg-green-600 text-white rounded text-sm"
              >
                Play
              </a>
            </div>
          )}

          <div className="flex items-center gap-2 text-xs text-gray-600">
            <input
              id="small-barcode-mode"
              type="checkbox"
              checked={smallBarcodeMode}
              onChange={(e) => setSmallBarcodeMode(e.target.checked)}
              className="h-3 w-3"
            />
            <label htmlFor="small-barcode-mode">
              Optimise scanner for small / tightly printed barcodes
            </label>
          </div>

          {decoded && (
            <div
              className={`p-4 rounded-lg border ${
                decoded.valid
                  ? "bg-green-50 border-green-200"
                  : "bg-yellow-50 border-yellow-200"
              }`}
            >
              {decoded.valid ? (
                mappedSong || mappedUrl ? (
                  <SongLinkCard song={mappedSong} fallbackUrl={mappedUrl} />
                ) : (
                  <p className="text-sm text-gray-600">
                    No saved song link for this code.
                  </p>
                )
              ) : (
                <p className="text-sm text-gray-700">
                  ⚠️ CRC Error — please hold the barcode steady and try again.
                </p>
              )}
            </div>
          )}

          <p className="text-xs text-center text-gray-500">
            Need to decode an image instead?{" "}
            <Link
              to="/scan/upload"
              className="text-indigo-600 font-medium underline"
            >
              Go to /scan/upload ↗
            </Link>
          </p>
        </div>
      )}

      {mode === "info" && (
        <div className="space-y-4 text-sm">
          <div className="bg-blue-50 p-4 rounded-lg">
            <h3 className="font-bold mb-2">🔒 CRC-8 Checksum</h3>
            <p>
              Validates data integrity. If any bar is misread, the CRC fails.
            </p>
          </div>
          <div className="bg-purple-50 p-4 rounded-lg">
            <h3 className="font-bold mb-2">📊 Gray Code</h3>
            <p>
              Adjacent heights differ by 1 bit. Misreading level 3 as 4 causes
              only 1 bit error.
            </p>
          </div>
          <div className="bg-green-50 p-4 rounded-lg">
            <h3 className="font-bold mb-2">🔀 Permutation</h3>
            <p>Data shuffled so adjacent bits aren't in adjacent bars.</p>
          </div>
          <div className="bg-orange-50 p-4 rounded-lg">
            <h3 className="font-bold mb-2">📍 Reference Bars</h3>
            <p>
              Positions 1, 12, 23 have fixed heights (0, 7, 0) for calibration.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default WaveformBarcodeV2;
