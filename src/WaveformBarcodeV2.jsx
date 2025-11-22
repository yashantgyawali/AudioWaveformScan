import React, { useState, useRef, useEffect, useCallback } from "react";

// Constants
const BAR_WIDTH = 24;
const SPACING = 4;
const UNIT_HEIGHT = 22;
const PADDING = 30;
const CANVAS_HEIGHT = 280;
const NUM_BARS = 23;
const HEIGHT_LEVELS = 8; // 0-7, like Spotify

// Gray code table for 3 bits (0-7)
const GRAY_ENCODE = [0, 1, 3, 2, 6, 7, 5, 4];
const GRAY_DECODE = [0, 1, 3, 2, 7, 6, 4, 5];

// CRC-8 calculation (polynomial x^8 + x^2 + x + 1)
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

// Convert number to bytes
const numToBytes = (num, len) => {
  const bytes = [];
  for (let i = len - 1; i >= 0; i--) {
    bytes.push((num >> (i * 8)) & 0xff);
  }
  return bytes;
};

// Encode media reference to bar heights
const MAX_40BIT = 0xffffffffff; // 40-bit max

const encodeToHeights = (mediaRef) => {
  const num = Number.parseInt(mediaRef, 10);
  if (Number.isNaN(num) || num < 0 || num > MAX_40BIT) return null;

  // Calculate CRC
  const bytes = numToBytes(num, 5);
  const checksum = crc8(bytes);

  // Combine: 40 bits data + 8 bits CRC = 48 bits
  // We'll encode 16 groups of 3 bits = 16 heights (levels 0-7)
  const combined = (BigInt(num) << 8n) | BigInt(checksum);

  // Extract 3-bit groups and apply Gray code
  const dataHeights = [];
  for (let i = 15; i >= 0; i--) {
    const bits = Number((combined >> BigInt(i * 3)) & 7n);
    dataHeights.push(GRAY_ENCODE[bits]);
  }

  // Permute to spread errors (every 7th position, mod 16)
  const permuted = [];
  for (let i = 0; i < 16; i++) {
    permuted.push(dataHeights[(i * 7) % 16]);
  }

  // Add reference bars: 0 at start, 7 at middle, 0 at end
  // Final structure: [0] + 10 bars + [7] + 10 bars + [0] = 23 bars
  // We have 16 data bars, so: [0] + 8 bars + [7] + 8 bars + [0] = 19 bars
  // Adjusted: [0] + first 10 + [7] + last 10 + [0] with padding
  const heights = [0];
  for (let i = 0; i < 10; i++) {
    heights.push(i < permuted.length ? permuted[i] : 0);
  }
  heights.push(7); // Reference bar (max height)
  for (let i = 10; i < 20; i++) {
    heights.push(i < permuted.length ? permuted[i] : 0);
  }
  heights.push(0);

  return heights;
};

// Decode bar heights to media reference
const decodeFromHeights = (heights) => {
  if (heights.length !== NUM_BARS) return { error: "Invalid bar count" };

  // Verify reference bars
  if (heights[0] > 1 || heights[NUM_BARS - 1] > 1) {
    return { error: "Invalid start/end markers" };
  }
  if (heights[11] < 6) {
    return { error: "Invalid center reference bar" };
  }

  // Extract data bars (skip reference bars at 0, 11, 22)
  const dataHeights = [];
  for (let i = 1; i <= 10; i++) dataHeights.push(heights[i]);
  for (let i = 12; i <= 21; i++) dataHeights.push(heights[i]);

  // Reverse permutation
  const unpermuted = new Array(16);
  for (let i = 0; i < 16; i++) {
    unpermuted[(i * 7) % 16] = dataHeights[i];
  }

  // Decode Gray code and reconstruct bits
  let combined = 0n;
  for (let i = 0; i < 16; i++) {
    const grayVal = Math.min(7, Math.max(0, Math.round(unpermuted[i])));
    const bits = GRAY_DECODE[grayVal];
    combined = (combined << 3n) | BigInt(bits);
  }

  // Extract data and checksum
  const checksum = Number(combined & 0xffn);
  const data = Number(combined >> 8n);

  // Verify CRC
  const bytes = numToBytes(data, 5);
  const calculatedCrc = crc8(bytes);

  if (calculatedCrc !== checksum) {
    return {
      error: `CRC mismatch (expected ${calculatedCrc}, got ${checksum})`,
      data,
    };
  }

  return { data, valid: true };
};

function WaveformBarcodeV2() {
  const [mode, setMode] = useState("generate");
  const [mediaRef, setMediaRef] = useState("1234567890");
  const [heights, setHeights] = useState([]);
  const [decoded, setDecoded] = useState(null);
  const [error, setError] = useState("");
  const canvasRef = useRef(null);
  const videoRef = useRef(null);
  const scanCanvasRef = useRef(null);
  const [scanning, setScanning] = useState(false);
  const [stream, setStream] = useState(null);
  const [scanMethod, setScanMethod] = useState("camera"); // 'camera' or 'upload'
  const [urlInput, setUrlInput] = useState("");
  const [mappedId, setMappedId] = useState("");
  const [cameraStatus, setCameraStatus] = useState("idle");
  const [videoSize, setVideoSize] = useState({ w: 0, h: 0 });
  const [streamTracks, setStreamTracks] = useState(0);

  // Helper: roundRect fallback for older canvas implementations
  const drawRoundedRect = useCallback((ctx, x, y, w, h, r) => {
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.fill();
      return;
    }
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
    ctx.fill();
  }, []);

  // helper to draw heights directly
  const drawHeights = useCallback(
    (result) => {
      if (!result) return;
      setError("");
      setHeights(result);
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      const totalWidth =
        (BAR_WIDTH + SPACING) * result.length - SPACING + PADDING * 2;
      canvas.width = totalWidth;
      canvas.height = CANVAS_HEIGHT;
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const centerY = canvas.height / 2;
      let x = PADDING;
      result.forEach((height, i) => {
        const barHeight = (height + 1) * UNIT_HEIGHT;
        const y = centerY - barHeight / 2;
        const isRef = i === 0 || i === 11 || i === result.length - 1;
        ctx.fillStyle = isRef ? "#666666" : "#000000";
        drawRoundedRect(ctx, x, y, BAR_WIDTH, barHeight, BAR_WIDTH / 2);
        x += BAR_WIDTH + SPACING;
      });
    },
    [drawRoundedRect]
  );

  const generateBarcode = useCallback(() => {
    const result = encodeToHeights(mediaRef);
    if (!result) {
      setError(`Enter a number between 0 and ${MAX_40BIT}`);
      return;
    }
    drawHeights(result);
  }, [mediaRef, drawHeights]);

  // Stop scanning (stable)
  const stopScanningCb = useCallback(() => {
    if (stream) {
      try {
        stream.getTracks().forEach((track) => track.stop());
      } catch (e) {
        console.warn("Error stopping tracks", e);
      }
    }
    if (videoRef.current) {
      try {
        videoRef.current.srcObject = null;
      } catch (e) {
        console.warn(e);
      }
    }
    setStream(null);
    setScanning(false);
  }, [stream]);

  const startScanning = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: 640, height: 480 },
      });
      setStream(s);
      setScanning(true);
      setDecoded(null);
      setError("");
    } catch (err) {
      console.error("getUserMedia error:", err);
      const msg = err && err.name ? `${err.name}: ${err.message}` : String(err);
      setError(
        `Camera error — ${msg}. Check browser/site permissions and macOS Camera privacy settings.`
      );
      setScanning(false);
    }
  };

  const stopScanning = () => {
    if (stream) {
      try {
        stream.getTracks().forEach((track) => track.stop());
      } catch (e) {
        console.warn("Error stopping tracks", e);
      }
    }
    if (videoRef.current) {
      try {
        videoRef.current.srcObject = null;
      } catch (e) {
        console.warn(e);
      }
    }
    setStream(null);
    setScanning(false);
  };

  // Attach stream to video element when available and guard video.play()
  useEffect(() => {
    const vid = videoRef.current;
    if (stream && vid) {
      try {
        vid.srcObject = stream;
        // mute to improve autoplay behavior across browsers
        try {
          vid.muted = true;
        } catch (err) {
          void err;
        }

        // set attached status (defer to avoid synchronous state update in effect)
        setTimeout(() => setCameraStatus("attached"), 0);

        const onLoaded = () => {
          setVideoSize({ w: vid.videoWidth || 0, h: vid.videoHeight || 0 });
          setCameraStatus("ready");
        };
        const onPlay = () => setCameraStatus("playing");
        const onError = (e) => {
          console.error("Video element error", e);
          setError("Video playback error");
          setCameraStatus("error");
        };

        vid.addEventListener("loadedmetadata", onLoaded);
        vid.addEventListener("play", onPlay);
        vid.addEventListener("error", onError);

        // Try to start playback — some browsers require an explicit play() after attach
        const p = vid.play();
        if (p && typeof p.catch === "function") {
          p.catch((e) => {
            if (e && e.name === "AbortError") return; // expected when element removed
            console.warn("video.play() failed:", e);
          });
        }

        // attach track-ended listeners for diagnostics
        const tracks = stream.getTracks();
        setTimeout(() => setStreamTracks(tracks.length), 0);
        const onTrackEnded = (ev) => {
          console.warn("MediaTrack ended", ev);
          setCameraStatus("stopped");
        };
        tracks.forEach((t) => t.addEventListener("ended", onTrackEnded));

        // cleanup listeners when stream changes or component unmounts
        return () => {
          try {
            vid.removeEventListener("loadedmetadata", onLoaded);
            vid.removeEventListener("play", onPlay);
            vid.removeEventListener("error", onError);
          } catch (err) {
            void err;
          }
          try {
            tracks.forEach((t) => t.removeEventListener("ended", onTrackEnded));
          } catch (err) {
            void err;
          }
          try {
            vid.srcObject = null;
          } catch (err) {
            void err;
          }
          setCameraStatus("stopped");
          setStreamTracks(0);
        };
      } catch (e) {
        console.error("Error attaching stream to video element", e);
      }
    }

    // if no stream, ensure status is idle/stopped
    return () => {
      if (vid) {
        try {
          vid.srcObject = null;
        } catch (err) {
          void err;
        }
      }
      setCameraStatus("idle");
    };
  }, [stream]);

  // Create an ID and map the provided URL to it in localStorage
  const handleEncodeUrl = () => {
    if (!urlInput || !urlInput.trim()) {
      setError("Enter a YouTube URL to encode");
      return;
    }
    // simple validation (optional)
    const url = urlInput.trim();
    // generate a random 10-digit id that's not already used
    let id;
    let attempts = 0;
    do {
      id = Math.floor(Math.random() * 1e10);
      attempts++;
      if (attempts > 10) break;
    } while (localStorage.getItem(`waveform:url:${id}`));
    localStorage.setItem(`waveform:url:${id}`, url);
    setMappedId(String(id));
    setMediaRef(String(id));
    const heights = encodeToHeights(String(id));
    if (heights) {
      drawHeights(heights);
      setError("");
    } else {
      setError("Failed to encode URL");
    }
  };

  const decodeCanvas = (canvas) => {
    const ctx = canvas.getContext("2d");
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    const getBrightness = (x, y) => {
      if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) return 255;
      const i = (Math.floor(y) * canvas.width + Math.floor(x)) * 4;
      return (data[i] + data[i + 1] + data[i + 2]) / 3;
    };

    const isBlack = (x, y) => getBrightness(x, y) < 128;

    // Scan multiple horizontal lines for robustness
    const scanLines = [0.4, 0.45, 0.5, 0.55, 0.6].map((r) =>
      Math.floor(canvas.height * r)
    );
    let bestBars = [];

    for (const centerY of scanLines) {
      const bars = [];
      let inBar = false,
        barStart = 0;

      for (let x = 0; x < canvas.width; x++) {
        const black = isBlack(x, centerY);
        if (black && !inBar) {
          inBar = true;
          barStart = x;
        } else if (!black && inBar) {
          inBar = false;
          const barWidth = x - barStart;
          if (barWidth >= 8) {
            const centerX = barStart + barWidth / 2;
            let topY = centerY,
              bottomY = centerY;
            while (topY > 0 && isBlack(centerX, topY - 1)) topY--;
            while (bottomY < canvas.height - 1 && isBlack(centerX, bottomY + 1))
              bottomY++;
            bars.push({ centerX, height: bottomY - topY + 1 });
          }
        }
      }
      if (bars.length > bestBars.length) bestBars = bars;
    }

    if (bestBars.length < 15) {
      setError(`Only found ${bestBars.length} bars. Need at least 15.`);
      return { error: `Only found ${bestBars.length} bars. Need at least 15.` };
    }

    const maxHeight = Math.max(...bestBars.map((b) => b.height));
    const unitH = maxHeight / 8;

    const detectedHeights = bestBars.map((bar) => {
      const level = Math.round(bar.height / unitH) - 1;
      return Math.max(0, Math.min(7, level));
    });

    while (detectedHeights.length < NUM_BARS) detectedHeights.push(0);
    const finalHeights = detectedHeights.slice(0, NUM_BARS);

    const result = decodeFromHeights(finalHeights);
    setDecoded(result);

    if (result && result.valid) {
      // try to look up mapped URL in localStorage
      const key = String(result.data);
      const mapped = localStorage.getItem(`waveform:url:${key}`);
      if (mapped) {
        // redirect
        window.location.href = mapped;
        return { result, redirected: true };
      }
    }

    return { result };
  };

  const captureAndDecode = () => {
    const video = videoRef.current;
    const canvas = scanCanvasRef.current;
    if (!video) {
      setError("Video element not available");
      return;
    }

    // Wait for video metadata (dimensions) if not ready
    const waitForMeta = () =>
      new Promise((resolve, reject) => {
        if (video.videoWidth && video.videoHeight) return resolve();
        const onMeta = () => {
          cleanup();
          resolve();
        };
        const onErr = (e) => {
          cleanup();
          reject(e);
        };
        const cleanup = () => {
          video.removeEventListener("loadedmetadata", onMeta);
          video.removeEventListener("error", onErr);
        };
        video.addEventListener("loadedmetadata", onMeta);
        video.addEventListener("error", onErr);
        // try to play in case browser requires it to produce metadata
        try {
          const p = video.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
        } catch {
          /* ignore */
        }
        // fallback timeout
        setTimeout(() => {
          if (video.videoWidth && video.videoHeight) resolve();
          else resolve();
        }, 500);
      });

    waitForMeta()
      .then(() => {
        const ctx = canvas.getContext("2d");
        const w = video.videoWidth || 640;
        const h = video.videoHeight || 480;
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);

        const out = decodeCanvas(canvas);
        if (out && out.result && out.result.valid) stopScanning();
        else if (out && out.error) setError(out.error);
      })
      .catch((e) => {
        console.error("Error waiting for video metadata", e);
        setError("Camera not ready — try again");
      });
  };

  const handleUploadImage = (file) => {
    if (!file) return;
    const canvas = scanCanvasRef.current;
    const ctx = canvas.getContext("2d");
    const img = new Image();
    img.onload = () => {
      // scale image to a reasonable size for scanning
      const scale = Math.min(1280 / img.width, 720 / img.height, 1);
      canvas.width = Math.floor(img.width * scale);
      canvas.height = Math.floor(img.height * scale);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const out = decodeCanvas(canvas);
      if (out && out.result && out.result.valid) {
        // handled by decodeCanvas (redirect) or show decoded id
      } else if (out && out.error) setError(out.error);
    };
    img.onerror = () => setError("Failed to load image");
    img.src = URL.createObjectURL(file);
  };

  // (No auto-generate on mount) generate manually using buttons or encode URL.

  // Ensure scanning stops on unmount
  useEffect(() => {
    return () => stopScanningCb();
  }, [stopScanningCb]);

  const downloadBarcode = () => {
    const link = document.createElement("a");
    link.download = `waveform-v2-${mediaRef}.png`;
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

      <div className="flex gap-2 mb-4 justify-center">
        <button
          onClick={() => {
            setMode("generate");
            stopScanning();
          }}
          className={`px-4 py-2 rounded-lg font-medium ${
            mode === "generate" ? "bg-black text-white" : "bg-gray-200"
          }`}
        >
          Generate
        </button>
        <button
          onClick={() => setMode("scan")}
          className={`px-4 py-2 rounded-lg font-medium ${
            mode === "scan" ? "bg-black text-white" : "bg-gray-200"
          }`}
        >
          Scan
        </button>
        <button
          onClick={() => setMode("info")}
          className={`px-4 py-2 rounded-lg font-medium ${
            mode === "info" ? "bg-black text-white" : "bg-gray-200"
          }`}
        >
          How It Works
        </button>
      </div>

      {mode === "generate" && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              YouTube URL (or any URL):
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                className="flex-1 p-3 border rounded-lg"
                placeholder="https://www.youtube.com/watch?v=..."
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
              Media Reference ID (0-9,999,999,999):
            </label>
            <input
              type="text"
              value={mediaRef}
              onChange={(e) =>
                setMediaRef(e.target.value.replace(/[^0-9]/g, "").slice(0, 10))
              }
              className="w-full p-3 border rounded-lg font-mono text-lg"
              placeholder="1234567890"
            />
            <div className="mt-2 flex gap-2">
              <button
                onClick={generateBarcode}
                className="px-4 py-2 bg-gray-800 text-white rounded"
              >
                Generate
              </button>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(mediaRef);
                }}
                className="px-4 py-2 bg-gray-200 rounded"
              >
                Copy ID
              </button>
            </div>
          </div>

          {error && <p className="text-red-500 text-sm">{error}</p>}

          <div className="bg-gray-50 p-4 rounded-lg flex justify-center">
            <canvas ref={canvasRef} className="max-w-full" />
          </div>

          <button
            onClick={downloadBarcode}
            className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700"
          >
            Download PNG
          </button>

          <div className="text-xs text-gray-600 bg-gray-50 p-3 rounded font-mono">
            <p>
              <strong>Heights:</strong> [{heights.join(", ")}]
            </p>
            <p>
              <strong>Structure:</strong> [ref] + 10 data + [ref] + 10 data +
              [ref]
            </p>
          </div>
        </div>
      )}

      {mode === "scan" && (
        <div className="space-y-4">
          <div className="flex gap-2">
            <button
              onClick={() => setScanMethod("camera")}
              className={`flex-1 py-2 rounded ${
                scanMethod === "camera" ? "bg-black text-white" : "bg-gray-200"
              }`}
            >
              Camera
            </button>
            <button
              onClick={() => setScanMethod("upload")}
              className={`flex-1 py-2 rounded ${
                scanMethod === "upload" ? "bg-black text-white" : "bg-gray-200"
              }`}
            >
              Upload Image
            </button>
          </div>

          {scanMethod === "camera" &&
            (!scanning ? (
              <button
                onClick={startScanning}
                className="w-full py-3 bg-green-600 text-white rounded-lg font-medium"
              >
                Start Camera
              </button>
            ) : (
              <div className="space-y-3">
                <div className="relative bg-black rounded-lg overflow-hidden min-h-[220px] flex flex-col justify-center items-center">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full"
                    style={{ minHeight: 200, background: "#222" }}
                  />
                  <div className="p-2 text-xs text-white/80">
                    Camera: {cameraStatus}
                    {videoSize.w ? ` • ${videoSize.w}x${videoSize.h}` : ""}
                    {streamTracks ? ` • tracks: ${streamTracks}` : ""}
                  </div>
                  {(!videoSize.w ||
                    cameraStatus === "stopped" ||
                    cameraStatus === "idle") && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className="text-white/70 text-center text-sm bg-black/60 px-4 py-2 rounded">
                        Camera preview not available
                        <br />
                        {cameraStatus === "stopped"
                          ? "Camera stopped or permission denied."
                          : "Waiting for camera..."}
                      </div>
                    </div>
                  )}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="border-2 border-green-400 w-4/5 h-20 rounded opacity-50" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={captureAndDecode}
                    className="flex-1 py-3 bg-blue-600 text-white rounded-lg"
                  >
                    Capture & Decode
                  </button>
                  <button
                    onClick={stopScanning}
                    className="px-4 py-3 bg-red-600 text-white rounded-lg"
                  >
                    Stop
                  </button>
                </div>
              </div>
            ))}

          {scanMethod === "upload" && (
            <div className="space-y-2">
              <input
                type="file"
                accept="image/*"
                onChange={(e) => handleUploadImage(e.target.files?.[0])}
              />
              <p className="text-xs text-gray-500">
                Upload an image of a waveform barcode to scan and redirect.
              </p>
            </div>
          )}

          <canvas ref={scanCanvasRef} className="hidden" />
          {error && <p className="text-red-500 text-sm">{error}</p>}

          {decoded && (
            <div
              className={`p-4 rounded-lg ${
                decoded.valid
                  ? "bg-green-50 border-green-200"
                  : "bg-yellow-50 border-yellow-200"
              } border`}
            >
              <p className="text-sm mb-1">
                {decoded.valid ? "✅ Valid barcode!" : "⚠️ CRC Error"}
              </p>
              <p className="font-mono text-2xl">{decoded.data}</p>
            </div>
          )}
        </div>
      )}

      {mode === "info" && (
        <div className="space-y-4 text-sm">
          <div className="bg-blue-50 p-4 rounded-lg">
            <h3 className="font-bold mb-2">🔒 CRC-8 Checksum</h3>
            <p>
              8-bit checksum validates data integrity. If any bar is misread,
              the CRC will fail, telling you to scan again.
            </p>
          </div>
          <div className="bg-purple-50 p-4 rounded-lg">
            <h3 className="font-bold mb-2">📊 Gray Code Encoding</h3>
            <p>
              Adjacent height levels differ by only 1 bit. If a bar is slightly
              misread (e.g., level 3 vs 4), only 1 bit is wrong instead of
              potentially all 3.
            </p>
          </div>
          <div className="bg-green-50 p-4 rounded-lg">
            <h3 className="font-bold mb-2">🔀 Permutation</h3>
            <p>
              Data is shuffled so adjacent bits aren't in adjacent bars. If one
              bar is completely lost, the errors are spread out and easier to
              recover.
            </p>
          </div>
          <div className="bg-orange-50 p-4 rounded-lg">
            <h3 className="font-bold mb-2">📍 Reference Bars</h3>
            <p>
              Bars at positions 1, 12, and 23 have fixed heights (0, 7, 0). This
              helps calibrate the scanner and detect the barcode orientation.
            </p>
          </div>
          <div className="bg-gray-100 p-4 rounded-lg">
            <h3 className="font-bold mb-2">💡 Usage with YouTube</h3>
            <p>
              Encode a short ID (e.g., 1234567890) → Your server maps this to
              YouTube URL → User scans → App fetches URL from your database
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default WaveformBarcodeV2;
